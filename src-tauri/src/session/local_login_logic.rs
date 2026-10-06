//! Saved-login document parsing and encoding, without filesystem access.
use crate::session::login_logic::LoginProfile;

pub(crate) const MAX_BYTES: u64 = 4096;

pub(crate) fn parse(bytes: &[u8]) -> Result<LoginProfile, ()> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(());
    }
    let profile: LoginProfile = serde_json::from_slice(bytes).map_err(|_| ())?;
    profile.validate().map_err(|_| ())?;
    Ok(profile)
}

pub(crate) fn encode(profile: &LoginProfile) -> Result<Vec<u8>, ()> {
    profile.validate().map_err(|_| ())?;
    let bytes = serde_json::to_vec(profile).map_err(|_| ())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::login_logic::ConnectionMode;
    use serde_json::{json, Value};

    fn profile() -> Value {
        json!({"username":"synthetic-account","password":"synthetic-password","characterSlot":1})
    }

    #[test]
    fn legacy_defaults_and_explicit_connection_mode_round_trip() {
        let mut value = profile();
        let parsed = parse(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(parsed.mode, ConnectionMode::GameClient);
        let encoded: Value = serde_json::from_slice(&encode(&parsed).unwrap()).unwrap();
        assert_eq!(encoded["autoLogin"], false);
        value["mode"] = "botOnly".into();
        value["autoLogin"] = true.into();
        let parsed = parse(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(parsed.mode, ConnectionMode::BotOnly);
        let restored: Value = serde_json::from_slice(&encode(&parsed).unwrap()).unwrap();
        assert_eq!(restored, value);
    }

    #[test]
    fn invalid_credentials_and_unknown_or_oversized_documents_reject() {
        for (key, invalid) in [
            ("username", Value::from(" ")),
            ("password", Value::from("")),
            ("password", Value::from("has\0null")),
            ("characterSlot", Value::from(3)),
            ("running", Value::from(true)),
        ] {
            let mut value = profile();
            value[key] = invalid;
            assert!(
                parse(&serde_json::to_vec(&value).unwrap()).is_err(),
                "{key}"
            );
        }
        assert!(parse(b"corrupt").is_err());
        assert!(parse(&vec![b' '; MAX_BYTES as usize + 1]).is_err());
        let mut parsed = parse(&serde_json::to_vec(&profile()).unwrap()).unwrap();
        parsed.password.clear();
        assert!(encode(&parsed).is_err());
    }
}
