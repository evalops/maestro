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
//! attacker-influenceable URLs; do not reimplement it. The A2A push
//! notification guard in `maestro-runtime-gateway` delegates here for the same
//! reason.
//!
//! [`is_blocked_ip`] is the exact negation of the public-address predicate.
//! In-tree vectors keep the boundary classification explicit.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::StatusCode;
use reqwest::header::LOCATION;
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
///
/// This is the exact negation of the public-address predicate used for
/// attacker-influenceable outbound requests. Boundary cases are checked
/// against `testdata/egress-ip-vectors.json` within this tree.
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(addr) => is_blocked_ipv4(addr),
        IpAddr::V6(addr) => is_blocked_ipv6(addr),
    }
}

/// The IPv4 address embedded in an IPv4-mapped (`::ffff:a.b.c.d`) or
/// IPv4-compatible (`::a.b.c.d`) IPv6 address. Both forms name an IPv4
/// destination, so a blocked IPv4 target must not become reachable by
/// re-encoding it as an IPv6 literal.
fn embedded_ipv4(addr: Ipv6Addr) -> Option<Ipv4Addr> {
    let octets = addr.octets();
    let is_compatible = octets[..12].iter().all(|octet| *octet == 0);
    let is_mapped =
        octets[..10].iter().all(|octet| *octet == 0) && octets[10] == 0xff && octets[11] == 0xff;
    if is_compatible || is_mapped {
        Some(Ipv4Addr::new(
            octets[12], octets[13], octets[14], octets[15],
        ))
    } else {
        None
    }
}

fn is_blocked_ipv4(addr: Ipv4Addr) -> bool {
    let [a, b, c, d] = addr.octets();
    if addr.is_unspecified()
        || addr.is_loopback()
        || addr.is_private()
        || addr.is_link_local()
        || addr.is_multicast()
        || addr.is_broadcast()
    {
        return true;
    }
    // `0.0.0.0/8` ("this network", RFC 791). `is_unspecified()` only matches
    // the exact all-zero address, not the rest of the block.
    if a == 0 {
        return true;
    }
    // `100.64.0.0/10` (RFC 6598 shared address space / CGNAT). `is_private()`
    // does not cover this range. This fleet's Tailscale network lives entirely
    // inside it, and Alibaba Cloud's instance metadata endpoint
    // (`100.100.100.200`) sits inside it too.
    if a == 100 && (64..=127).contains(&b) {
        return true;
    }
    // `192.0.0.0/24` (IETF protocol assignments, RFC 6890). `192.0.0.9` (PCP
    // anycast, RFC 7723) and `192.0.0.10` (NAT64/DNS64 discovery anycast, RFC
    // 8155) are the only entries IANA marks globally reachable.
    if a == 192 && b == 0 && c == 0 {
        return !matches!(d, 9 | 10);
    }
    // `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` (documentation).
    if addr.is_documentation() {
        return true;
    }
    // `192.88.99.0/24` (6to4 relay anycast, deprecated by RFC 7526).
    if a == 192 && b == 88 && c == 99 {
        return true;
    }
    // `198.18.0.0/15` (benchmarking, RFC 2544).
    if a == 198 && matches!(b, 18 | 19) {
        return true;
    }
    // `240.0.0.0/4` (reserved for future use).
    a >= 240
}

fn is_blocked_ipv6(addr: Ipv6Addr) -> bool {
    if addr.is_loopback() || addr.is_unspecified() {
        return true;
    }
    if let Some(embedded) = embedded_ipv4(addr) {
        return is_blocked_ipv4(embedded);
    }
    let segments = addr.segments();
    if addr.is_multicast()
        // `fc00::/7` (unique local addresses, RFC 4193).
        || (segments[0] & 0xfe00) == 0xfc00
        // `fe80::/10` (link-local unicast).
        || (segments[0] & 0xffc0) == 0xfe80
        // `fec0::/10` (site-local, deprecated by RFC 3879).
        || (segments[0] & 0xffc0) == 0xfec0
    {
        return true;
    }
    // `64:ff9b::/32` holds both assigned NAT64 translation prefixes (RFC 6052
    // `64:ff9b::/96` and RFC 8215 `64:ff9b:1::/48`); the low bits carry a
    // caller-chosen IPv4 destination.
    if segments[0] == 0x0064 && segments[1] == 0xff9b {
        return true;
    }
    // `100::/64` (discard-only, RFC 6666) and `100:0:0:1::/64` (dummy prefix,
    // RFC 9780).
    if segments[0] == 0x0100 && segments[1] == 0 && segments[2] == 0 && matches!(segments[3], 0 | 1)
    {
        return true;
    }
    // `2001:db8::/32` (documentation) and `2001:2::/48` (benchmarking).
    if segments[0] == 0x2001 && matches!(segments[1], 0x0db8 | 0x0002) {
        return true;
    }
    // `2001::/23` (IETF protocol assignments, RFC 2928), which includes
    // Teredo `2001::/32` and the deprecated ORCHID prefix `2001:10::/28`.
    if segments[0] == 0x2001 && segments[1] <= 0x01ff {
        return !is_globally_reachable_protocol_assignment(segments);
    }
    // `2002::/16` (6to4, deprecated by RFC 7526), `3fff::/20` (documentation,
    // RFC 9637), `5f00::/16` (segment routing SIDs, RFC 9602).
    segments[0] == 0x2002
        || (segments[0] == 0x3fff && (segments[1] & 0xf000) == 0)
        || segments[0] == 0x5f00
}

/// The `2001::/23` children IANA marks globally reachable: the `2001:1::1..3`
/// anycast addresses, AMT (`2001:3::/32`), AS112-v6 (`2001:4:112::/48`),
/// ORCHIDv2 (`2001:20::/28`), and drone remote ID (`2001:30::/28`).
fn is_globally_reachable_protocol_assignment(segments: [u16; 8]) -> bool {
    (segments[1] == 0x0001
        && segments[2..7].iter().all(|segment| *segment == 0)
        && matches!(segments[7], 1..=3))
        || segments[1] == 0x0003
        || (segments[1] == 0x0004 && segments[2] == 0x0112)
        || (segments[1] & 0xfff0) == 0x0020
        || (segments[1] & 0xfff0) == 0x0030
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shared classification vectors for the local egress policy test.
    const EGRESS_VECTORS: &str = include_str!("../../testdata/egress-ip-vectors.json");

    #[test]
    fn test_shared_egress_vectors_classify_identically() {
        let parsed: serde_json::Value =
            serde_json::from_str(EGRESS_VECTORS).expect("shared egress vector file parses");
        let vectors = parsed["ip_vectors"]
            .as_array()
            .expect("ip_vectors is an array");
        assert!(vectors.len() >= 70, "the shared vector table lost entries");
        for vector in vectors {
            let address = vector["address"]
                .as_str()
                .expect("vector address is a string");
            let expected = vector["blocked"]
                .as_bool()
                .expect("vector blocked is a bool");
            let note = vector["note"].as_str().unwrap_or("");
            let ip: IpAddr = address.parse().expect("vector address parses");
            assert_eq!(is_blocked_ip(ip), expected, "{address} ({note})");
        }
    }

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
