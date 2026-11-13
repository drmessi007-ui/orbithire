pub const MAX_QUERY_CHARS: usize = 500;
pub const DEFAULT_RATE_LIMIT_NS: u64 = 60 * 60 * 1_000_000_000;
pub const DEFAULT_REFUND_WINDOW_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

const ALLOWED_QUERY_PUNCTUATION: &str = "?¿!¡.,;:'\"-()[]{}_/:%+@#$&*=";

pub fn is_valid_uuid_v4(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }

    for (index, byte) in bytes.iter().enumerate() {
        let is_separator = matches!(index, 8 | 13 | 18 | 23);
        if is_separator {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase() {
            return false;
        }
    }

    bytes[14] == b'4' && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

pub fn is_valid_query(value: &str) -> bool {
    if value.len() > MAX_QUERY_CHARS * 4 || value.trim().is_empty() {
        return false;
    }

    let mut char_count = 0;
    value.chars().all(|character| {
        char_count += 1;
        char_count <= MAX_QUERY_CHARS
            && !character.is_control()
            && (character.is_alphanumeric()
                || character.is_whitespace()
                || ALLOWED_QUERY_PUNCTUATION.contains(character))
    }) && char_count > 0
}

pub fn is_valid_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub fn to_lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_UUID: &str = "550e8400-e29b-41d4-a716-446655440000";

    #[test]
    fn accepts_the_demo_queries_and_rejects_controls_and_oversized_input() {
        assert!(is_valid_query("¿hay tormenta geomagnética hoy?"));
        assert!(is_valid_query("¿a qué hora pasa la ISS sobre Osorno?"));
        assert!(!is_valid_query(""));
        assert!(!is_valid_query("   "));
        assert!(!is_valid_query("query\ninjected"));
        assert!(!is_valid_query(&"a".repeat(MAX_QUERY_CHARS + 1)));
        assert!(!is_valid_query(&"a".repeat(1_000_000)));
        assert!(is_valid_query(&"a".repeat(MAX_QUERY_CHARS)));
        assert!(!is_valid_query("<script>alert(1)</script>"));
    }

    #[test]
    fn validates_uuid_v4_and_lowercase_sha256() {
        assert!(is_valid_uuid_v4(VALID_UUID));
        assert!(!is_valid_uuid_v4("550e8400-e29b-11d4-a716-446655440000"));
        assert!(!is_valid_uuid_v4("550E8400-E29B-41D4-A716-446655440000"));
        assert!(!is_valid_uuid_v4("550e8400e29b41d4a716446655440000"));
        assert!(is_valid_sha256_hex(&"a".repeat(64)));
        assert!(!is_valid_sha256_hex(&"A".repeat(64)));
        assert!(!is_valid_sha256_hex("xyz"));
    }

    #[test]
    fn deterministic_ten_thousand_input_fuzz_smoke() {
        let mut state = 0x7a31_94d2_0bb3_c651_u64;
        for _ in 0..10_000 {
            let length = (next(&mut state) % 700) as usize;
            let mut bytes = Vec::with_capacity(length);
            for _ in 0..length {
                bytes.push((next(&mut state) & 0xff) as u8);
            }
            let candidate = String::from_utf8_lossy(&bytes);

            let _ = is_valid_query(&candidate);
            let _ = is_valid_uuid_v4(&candidate);
            let _ = is_valid_sha256_hex(&candidate);
        }
    }

    fn next(state: &mut u64) -> u64 {
        *state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        *state
    }
}
