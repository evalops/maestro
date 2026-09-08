//! Compress only after this server advertises support; legacy servers stay plain.
use super::*;
use flate2::{Compression, write::GzEncoder};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum WireEncoding {
    Zstd,
    Gzip,
}
impl WireEncoding {
    pub(super) fn header(self) -> &'static str {
        match self {
            Self::Zstd => "zstd",
            Self::Gzip => "gzip",
        }
    }
}

pub(super) fn compress_body(
    body: &[u8],
    encoding: WireEncoding,
) -> Result<Option<Vec<u8>>, TranscriptError> {
    if body.len() < 1024 {
        return Ok(None);
    }
    let compressed = match encoding {
        WireEncoding::Zstd => zstd::bulk::compress(body, 1)?,
        WireEncoding::Gzip => {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
            encoder.write_all(body)?;
            encoder.finish()?
        }
    };
    Ok((compressed.len() + (body.len() / 8).max(64) < body.len()).then_some(compressed))
}

pub(super) fn preferred_encoding(value: Option<&str>) -> Option<WireEncoding> {
    let value = value?;
    [WireEncoding::Zstd, WireEncoding::Gzip]
        .into_iter()
        .filter_map(|encoding| {
            let quality = value.split(',')
                .filter_map(|member| advertised_quality(member, encoding))
                .max()?;
            (quality > 0).then_some((encoding, quality))
        })
        // Preserve the existing Zstandard preference when weights are equal.
        .max_by_key(|(encoding, quality)| (*quality, *encoding == WireEncoding::Zstd))
        .map(|(encoding, _)| encoding)
}

fn advertised_quality(member: &str, encoding: WireEncoding) -> Option<u16> {
    let mut parts = member.split(';');
    if !parts.next()?.trim().eq_ignore_ascii_case(encoding.header()) {
        return None;
    }
    let Some(weight) = parts.next() else {
        return Some(1000);
    };
    if parts.next().is_some() {
        return None;
    }
    let (name, value) = weight.trim().split_once('=')?;
    if !name.trim().eq_ignore_ascii_case("q") {
        return None;
    }
    // RFC 9110 section 12.4.2: 0..1, at most three fractional digits.
    let (whole, fraction) = value.trim().split_once('.').unwrap_or((value.trim(), ""));
    if fraction.len() > 3 || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    match whole {
        "1" if fraction.bytes().all(|byte| byte == b'0') => Some(1000),
        "0" => Some(if fraction.is_empty() {
            0
        } else {
            fraction.parse::<u16>().ok()? * 10_u16.pow(3 - fraction.len() as u32)
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    #[test]
    fn advertised_quality_values_select_the_best_supported_encoding() {
        for (header, expected) in [
            ("zstd;q=1.0", Some(WireEncoding::Zstd)),
            ("gzip; q=0.8", Some(WireEncoding::Gzip)),
            ("zstd;q=0.2, gzip;q=0.8", Some(WireEncoding::Gzip)),
            ("gzip;q=0.8, ZSTD;Q=0.800", Some(WireEncoding::Zstd)),
            ("zstd;q=0, gzip;q=0.001", Some(WireEncoding::Gzip)),
            ("gzip;q=1., zstd;q=0.", Some(WireEncoding::Gzip)),
            ("gzip;q=0, zstd;q=0.000", None),
            ("br;q=1, gzip;q=0.5", Some(WireEncoding::Gzip)),
            ("*;q=1", None),
        ] {
            assert_eq!(preferred_encoding(Some(header)), expected, "{header}");
        }
        for invalid in [
            "-1", "2", "1.001", "0.1234", "NaN", "", ".8", "00", "0.5;q=1",
        ] {
            assert_eq!(
                preferred_encoding(Some(&format!("zstd;q={invalid}, gzip;q=0.5"))),
                Some(WireEncoding::Gzip),
                "{invalid}"
            );
        }
    }

    #[test]
    fn compression_is_lossless_and_skips_small_requests() {
        assert!(
            compress_body(b"small", WireEncoding::Gzip)
                .unwrap()
                .is_none()
        );
        let bytes = b"canonical transcript text\n".repeat(1000);
        let compressed = compress_body(&bytes, WireEncoding::Gzip).unwrap().unwrap();
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(compressed.as_slice())
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(bytes, decoded);
        assert_eq!(
            preferred_encoding(Some("identity, gzip")),
            Some(WireEncoding::Gzip)
        );
        assert_eq!(
            preferred_encoding(Some("gzip, zstd")),
            Some(WireEncoding::Zstd)
        );
        assert_eq!(
            zstd::bulk::decompress(
                &compress_body(&bytes, WireEncoding::Zstd).unwrap().unwrap(),
                bytes.len()
            )
            .unwrap(),
            bytes
        );
        assert_eq!(preferred_encoding(None), None);
        assert_eq!(preferred_encoding(Some("gzip;q=0")), None);
    }
}
