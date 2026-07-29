//! Shared SSRF-safe outbound HTTP fetch helpers.
//!
//! Any tool that fetches a URL that could be influenced by the model, tool
//! output, or content pulled from the network (i.e. anything an attacker can
//! steer) MUST route the request through [`fetch_with_validated_redirects`]
//! rather than building a bare `reqwest::Client`. That function:
//!
//! - Resolves the host to a concrete address **before** connecting and
//!   rejects private, loopback, link-local, multicast, CGNAT, and other
//!   special-use ranges via [`is_blocked_ip`]. This is what stops a fetch to
//!   `http://169.254.169.254/...` (cloud metadata) or to an internal service
//!   on this fleet's `100.64.0.0/10` Tailscale network.
//! - Pins the outgoing connection to the address it just validated
//!   (`resolve_to_addrs`), closing the DNS-rebinding TOCTOU window between
//!   "resolve and check" and "actually connect".
//! - Disables reqwest's built-in redirect following
//!   (`redirect::Policy::none()`) and re-validates + re-pins on every hop, so
//!   a 3xx response cannot be used to reach a blocked address once the first
//!   hop has passed validation.
//!
//! This logic used to live only in `web_fetch.rs`; `extract_document.rs`
//! built its own unvalidated `reqwest::Client` (scheme check only, default
//! redirect policy, no pinning) and drifted out of sync — an SSRF into cloud
//! IAM credentials via
//! `http://169.254.169.254/latest/meta-data/iam/security-credentials/`.
//! Keep this the single implementation for every tool that fetches
//! attacker-influenceable URLs; do not reimplement it.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::header::LOCATION;
use reqwest::StatusCode;
use tokio::net::lookup_host;

/// Maximum redirect hops to follow before giving up.
pub(crate) const MAX_REDIRECTS: usize = 10;

/// Default `User-Agent` for tool-initiated outbound fetches.
pub(crate) const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (compatible; ComposerAgent/1.0)";

/// Validate that a URL uses an allowed scheme and has a host. Does not
/// resolve or check the address itself; call [`resolve_public_endpoint`] for
/// that.
pub(crate) fn validate_fetch_url(url: &reqwest::Url) -> Result<(), String> {
    match url.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(format!(
                "Unsupported URL scheme '{scheme}': only http and https are allowed"
            ));
        }
    }

    if url.host_str().is_none() {
        return Err("Invalid URL: missing host".to_string());
    }

    Ok(())
}

/// Resolve `url`'s host to a single address, rejecting private/reserved
/// targets. Returns the address the caller should pin the connection to.
pub(crate) async fn resolve_public_endpoint(url: &reqwest::Url) -> Result<SocketAddr, String> {
    validate_fetch_url(url)?;
    let host = url
        .host_str()
        .ok_or_else(|| "Invalid URL: missing host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Invalid URL: missing port".to_string())?;

    if let Some(ip) = parse_host_ip(host) {
        if is_blocked_ip(ip) {
            return Err(format!("blocked network target: {ip}"));
        }
        return Ok(SocketAddr::new(ip, port));
    }

    let addrs: Vec<SocketAddr> = lookup_host((host, port))
        .await
        .map_err(|err| format!("failed to resolve {host}: {err}"))?
        .collect();

    if addrs.is_empty() {
        return Err(format!("failed to resolve {host}: no addresses returned"));
    }

    if let Some(blocked) = addrs.iter().copied().find(|addr| is_blocked_ip(addr.ip())) {
        return Err(format!("blocked network target: {}", blocked.ip()));
    }

    addrs
        .into_iter()
        .next()
        .ok_or_else(|| format!("failed to resolve {host}: no addresses returned"))
}

/// Build a client pinned to `addr` for `url`'s host, with redirects
/// disabled — the caller re-validates and re-pins each hop itself via
/// [`fetch_with_validated_redirects`].
pub(crate) fn pinned_client(
    url: &reqwest::Url,
    addr: SocketAddr,
    timeout: Duration,
    user_agent: &str,
) -> Result<reqwest::Client, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Invalid URL: missing host".to_string())?;

    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(user_agent.to_string())
        .resolve_to_addrs(host, &[addr])
        .build()
        .map_err(|err| err.to_string())
}

/// Fetch `initial_url`, validating and pinning the resolved address at every
/// hop. Never delegates redirect-following to reqwest, so a redirect to a
/// blocked address (e.g. cloud metadata) is rejected before it is connected
/// to, not just on the first hop.
pub(crate) async fn fetch_with_validated_redirects(
    initial_url: reqwest::Url,
    timeout: Duration,
    user_agent: &str,
) -> Result<reqwest::Response, String> {
    let mut current_url = initial_url;

    for redirect_count in 0..=MAX_REDIRECTS {
        let resolved_addr = resolve_public_endpoint(&current_url).await?;
        let response = pinned_client(&current_url, resolved_addr, timeout, user_agent)?
            .get(current_url.clone())
            .send()
            .await
            .map_err(|err| err.to_string())?;

        if !is_redirect_status(response.status()) {
            return Ok(response);
        }

        if redirect_count == MAX_REDIRECTS {
            return Err(format!("too many redirects (max {MAX_REDIRECTS})"));
        }

        let location = response
            .headers()
            .get(LOCATION)
            .ok_or_else(|| format!("redirect from {current_url} missing Location header"))?;
        let location = location
            .to_str()
            .map_err(|_| "redirect Location header is not valid UTF-8".to_string())?;

        current_url = redirect_target_url(&current_url, location)?;
    }

    unreachable!("redirect loop exits by returning a response or max-redirect error");
}

/// Resolve a redirect `Location` header against the current URL. Only
/// validates scheme/host shape here; the caller must still call
/// [`resolve_public_endpoint`] on the result before connecting.
pub(crate) fn redirect_target_url(
    current_url: &reqwest::Url,
    location: &str,
) -> Result<reqwest::Url, String> {
    let next = current_url
        .join(location)
        .map_err(|err| format!("invalid redirect target: {err}"))?;
    validate_fetch_url(&next)?;
    Ok(next)
}

fn is_redirect_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

fn parse_host_ip(host: &str) -> Option<IpAddr> {
    host.parse::<IpAddr>().ok().or_else(|| {
        host.strip_prefix('[')
            .and_then(|trimmed| trimmed.strip_suffix(']'))
            .and_then(|trimmed| trimmed.parse::<IpAddr>().ok())
    })
}

/// Returns true if `ip` is a private, reserved, or otherwise non-public
/// address that outbound tool fetches must not reach.
pub(crate) fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(addr) => is_blocked_ipv4(addr),
        IpAddr::V6(addr) => {
            addr.to_ipv4_mapped().is_some_and(is_blocked_ipv4)
                || ipv4_compatible_addr(addr).is_some_and(is_blocked_ipv4)
                || is_blocked_ipv6(addr)
        }
    }
}

fn ipv4_compatible_addr(addr: Ipv6Addr) -> Option<Ipv4Addr> {
    let octets = addr.octets();
    if octets[..12].iter().all(|octet| *octet == 0) {
        Some(Ipv4Addr::new(
            octets[12], octets[13], octets[14], octets[15],
        ))
    } else {
        None
    }
}

fn is_blocked_ipv4(addr: Ipv4Addr) -> bool {
    addr.is_private()
        || addr.is_loopback()
        || addr.is_link_local()
        || addr.is_multicast()
        || addr.is_broadcast()
        || addr.is_unspecified()
        || is_shared_address_space_ipv4(addr)
        || is_current_network_ipv4(addr)
        || is_ietf_protocol_assignment_ipv4(addr)
        || is_benchmarking_ipv4(addr)
        || is_reserved_ipv4(addr)
}

/// `100.64.0.0/10` (RFC 6598 "Shared Address Space" / CGNAT).
///
/// `Ipv4Addr::is_private()` does not cover this range. This fleet's
/// Tailscale network lives entirely inside it, and Alibaba Cloud's instance
/// metadata endpoint (`100.100.100.200`) sits inside it too, so this was a
/// gap that let a fetch tool reach both internal fleet services and a cloud
/// metadata endpoint.
fn is_shared_address_space_ipv4(addr: Ipv4Addr) -> bool {
    let octets = addr.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

/// `0.0.0.0/8` ("this network", RFC 791). `is_unspecified()` only matches
/// the exact all-zero address, not the rest of the block.
fn is_current_network_ipv4(addr: Ipv4Addr) -> bool {
    addr.octets()[0] == 0
}

/// `192.0.0.0/24` (IETF protocol assignments, RFC 6890).
fn is_ietf_protocol_assignment_ipv4(addr: Ipv4Addr) -> bool {
    let octets = addr.octets();
    octets[0] == 192 && octets[1] == 0 && octets[2] == 0
}

/// `198.18.0.0/15` (benchmarking, RFC 2544).
fn is_benchmarking_ipv4(addr: Ipv4Addr) -> bool {
    let octets = addr.octets();
    octets[0] == 198 && (octets[1] == 18 || octets[1] == 19)
}

/// `240.0.0.0/4` (reserved for future use; also covers the broadcast
/// address, which `is_broadcast()` already blocks).
fn is_reserved_ipv4(addr: Ipv4Addr) -> bool {
    addr.octets()[0] >= 240
}

fn is_blocked_ipv6(addr: Ipv6Addr) -> bool {
    addr.is_loopback()
        || addr.is_unspecified()
        || addr.is_multicast()
        || is_unique_local_ipv6(addr)
        || is_unicast_link_local_ipv6(addr)
}

/// `fc00::/7` (unique local addresses, RFC 4193).
fn is_unique_local_ipv6(addr: Ipv6Addr) -> bool {
    (addr.segments()[0] & 0xfe00) == 0xfc00
}

/// `fe80::/10` (link-local unicast).
fn is_unicast_link_local_ipv6(addr: Ipv6Addr) -> bool {
    (addr.segments()[0] & 0xffc0) == 0xfe80
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_fetch_url_rejects_non_http_schemes() {
        let url = reqwest::Url::parse("file:///etc/passwd").unwrap();
        let err = validate_fetch_url(&url).unwrap_err();
        assert!(err.contains("Unsupported URL scheme"));
    }

    #[test]
    fn test_validate_fetch_url_allows_http_and_https() {
        assert!(validate_fetch_url(&reqwest::Url::parse("http://example.com").unwrap()).is_ok());
        assert!(validate_fetch_url(&reqwest::Url::parse("https://example.com").unwrap()).is_ok());
    }

    #[test]
    fn test_redirect_target_rejects_non_http_schemes() {
        let current = reqwest::Url::parse("https://example.com/start").unwrap();
        let err = redirect_target_url(&current, "file:///etc/passwd").unwrap_err();
        assert!(err.contains("Unsupported URL scheme"));
    }

    #[test]
    fn test_redirect_target_allows_relative_http_hop() {
        let current = reqwest::Url::parse("https://example.com/path/start").unwrap();
        let next = redirect_target_url(&current, "../next").unwrap();
        assert_eq!(next.as_str(), "https://example.com/next");
    }

    // ─────────────────────────────────────────────────────────────────────
    // is_blocked_ip: existing private/local/loopback coverage
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_blocks_private_and_local_addresses() {
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))));
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_blocked_ip(IpAddr::V6(
            "fd00::1".parse::<Ipv6Addr>().unwrap()
        )));
        assert!(is_blocked_ip(IpAddr::V6(
            "::ffff:127.0.0.1".parse::<Ipv6Addr>().unwrap()
        )));
        assert!(is_blocked_ip(IpAddr::V6(
            "::127.0.0.1".parse::<Ipv6Addr>().unwrap()
        )));
        assert!(is_blocked_ip(IpAddr::V6(
            "::10.0.0.1".parse::<Ipv6Addr>().unwrap()
        )));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))));
        assert!(!is_blocked_ip(IpAddr::V6(
            "::93.184.216.34".parse::<Ipv6Addr>().unwrap()
        )));
    }

    // ─────────────────────────────────────────────────────────────────────
    // is_blocked_ip: CGNAT / Tailscale (100.64.0.0/10) — regression coverage
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_blocks_cgnat_shared_address_space() {
        // Start, end, and interior of 100.64.0.0/10.
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 0))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(100, 100, 100, 200)))); // Alibaba Cloud metadata
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(100, 127, 255, 255))));
    }

    #[test]
    fn test_does_not_block_addresses_adjacent_to_cgnat_range() {
        // 100.63.0.0 and 100.128.0.0 are outside the reserved /10 and are
        // routable public space; the blocklist must not over-block them.
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(100, 63, 255, 255))));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(100, 128, 0, 0))));
    }

    #[test]
    fn test_blocks_cgnat_via_ipv4_mapped_ipv6() {
        // Classic bypass: encode the blocked IPv4 target as an IPv4-mapped
        // IPv6 literal (`::ffff:a.b.c.d`) to route around a naive IPv4-only
        // blocklist.
        assert!(is_blocked_ip(IpAddr::V6(
            "::ffff:100.64.0.1".parse::<Ipv6Addr>().unwrap()
        )));
        assert!(is_blocked_ip(IpAddr::V6(
            "::ffff:100.100.100.200".parse::<Ipv6Addr>().unwrap()
        )));
    }

    #[test]
    fn test_blocks_metadata_ip_via_ipv4_mapped_ipv6() {
        assert!(is_blocked_ip(IpAddr::V6(
            "::ffff:169.254.169.254".parse::<Ipv6Addr>().unwrap()
        )));
    }

    // ─────────────────────────────────────────────────────────────────────
    // is_blocked_ip: remaining special-use ranges
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn test_blocks_current_network_0_0_0_0_8() {
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(0, 1, 2, 3))));
    }

    #[test]
    fn test_blocks_ietf_protocol_assignment_192_0_0_0_24() {
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(192, 0, 0, 8))));
    }

    #[test]
    fn test_blocks_benchmarking_198_18_0_0_15() {
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(198, 18, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(198, 19, 255, 255))));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(198, 20, 0, 1))));
    }

    #[test]
    fn test_blocks_reserved_240_0_0_0_4() {
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(240, 0, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::BROADCAST)));
    }

    #[test]
    fn test_blocks_multicast_and_broadcast() {
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V6(
            "ff02::1".parse::<Ipv6Addr>().unwrap()
        )));
    }

    #[test]
    fn test_does_not_block_public_addresses() {
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
    }

    // ─────────────────────────────────────────────────────────────────────
    // resolve_public_endpoint: literal-address rejection (no DNS needed)
    // ─────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_resolve_rejects_loopback_literal() {
        let url = reqwest::Url::parse("http://127.0.0.1/metadata").unwrap();
        let err = resolve_public_endpoint(&url).await.unwrap_err();
        assert!(err.contains("blocked network target"));
    }

    #[tokio::test]
    async fn test_resolve_rejects_cloud_metadata_literal() {
        let url = reqwest::Url::parse(
            "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        )
        .unwrap();
        let err = resolve_public_endpoint(&url).await.unwrap_err();
        assert!(err.contains("blocked network target"));
    }

    #[tokio::test]
    async fn test_resolve_rejects_cgnat_literal() {
        let url = reqwest::Url::parse("http://100.64.0.5/internal").unwrap();
        let err = resolve_public_endpoint(&url).await.unwrap_err();
        assert!(err.contains("blocked network target"));
    }

    #[tokio::test]
    async fn test_resolve_rejects_ipv4_mapped_metadata_literal() {
        let url = reqwest::Url::parse("http://[::ffff:169.254.169.254]/metadata").unwrap();
        let err = resolve_public_endpoint(&url).await.unwrap_err();
        assert!(err.contains("blocked network target"));
    }

    #[tokio::test]
    async fn test_resolve_rejects_ipv4_compatible_loopback_literal() {
        let url = reqwest::Url::parse("http://[::127.0.0.1]/metadata").unwrap();
        let err = resolve_public_endpoint(&url).await.unwrap_err();
        assert!(err.contains("blocked network target"));
    }

    #[tokio::test]
    async fn test_resolve_rejects_ipv6_loopback_literal() {
        let url = reqwest::Url::parse("http://[::1]/metadata").unwrap();
        let err = resolve_public_endpoint(&url).await.unwrap_err();
        assert!(err.contains("blocked network target"));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Redirect-to-blocked-address is rejected before connecting.
    //
    // `fetch_with_validated_redirects` calls `resolve_public_endpoint` on
    // every hop's URL *before* issuing the request for that hop (see the
    // loop body above). This test exercises exactly that ordering: a
    // redirect `Location` pointing at cloud metadata parses fine as a URL
    // (scheme/host shape is valid), but resolving it for the next hop must
    // fail closed rather than ever being connected to.
    // ─────────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_redirect_to_metadata_ip_is_rejected_before_connecting() {
        let current = reqwest::Url::parse("https://example.com/start").unwrap();
        let next = redirect_target_url(
            &current,
            "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        )
        .unwrap();
        let err = resolve_public_endpoint(&next).await.unwrap_err();
        assert!(err.contains("blocked network target"));
    }

    #[tokio::test]
    async fn test_redirect_to_cgnat_ip_is_rejected_before_connecting() {
        let current = reqwest::Url::parse("https://example.com/start").unwrap();
        let next = redirect_target_url(&current, "http://100.64.5.5/internal-service").unwrap();
        let err = resolve_public_endpoint(&next).await.unwrap_err();
        assert!(err.contains("blocked network target"));
    }
}
