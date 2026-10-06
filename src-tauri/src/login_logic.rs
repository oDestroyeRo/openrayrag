//! Account schemas and login request policy, without saved-profile or UI effects.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionMode {
    BotOnly,
    #[default]
    GameClient,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LoginProfile {
    pub(crate) username: String,
    pub(crate) password: String,
    pub(crate) character_slot: u8,
    #[serde(default)]
    pub(crate) mode: ConnectionMode,
    #[serde(default)]
    pub(crate) auto_login: bool,
}

impl LoginProfile {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.username.trim().is_empty()
            || self.username.chars().count() > 64
            || self.username.chars().any(char::is_control)
            || self.password.is_empty()
            || self.password.len() > 256
            || self.password.contains('\0')
            || self.character_slot > 2
        {
            return Err("Enter a username, password and character slot 1–3.".into());
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedLogin {
    pub(crate) mode: ConnectionMode,
    pub(crate) username: String,
    pub(crate) character_slot: u8,
    pub(crate) auto_login: bool,
}

/// Proven account metadata only; continuation storage never receives credentials.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateAccount {
    pub username: String,
    pub character_slot: u8,
    pub mode: ConnectionMode,
}
impl UpdateAccount {
    pub fn validate(&self) -> Result<(), String> {
        if self.username.trim().is_empty()
            || self.username.chars().count() > 64
            || self.username.chars().any(char::is_control)
            || self.character_slot > 2
        {
            return Err("Update account is invalid.".into());
        }
        Ok(())
    }
    pub(crate) fn from_profile(profile: &LoginProfile) -> Self {
        Self {
            username: profile.username.clone(),
            character_slot: profile.character_slot,
            mode: profile.mode,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LoginRequest {
    #[serde(default)]
    pub(crate) mode: Option<ConnectionMode>,
    // Null credentials mean reuse the local profile. Its password never returns
    // to the controller webview.
    pub(crate) credentials: Option<LoginProfile>,
    pub(crate) character_slot: u8,
    pub(crate) remember: bool,
    pub(crate) auto_login: bool,
}

pub(crate) fn validate_request(request: &LoginRequest) -> Result<(), String> {
    if request.auto_login && !request.remember {
        return Err("Save the login on this Mac to sign in when the app opens.".into());
    }
    Ok(())
}

pub(crate) fn resolve_profile(
    request: LoginRequest,
    saved: Option<LoginProfile>,
) -> Result<LoginProfile, String> {
    validate_request(&request)?;
    let mut profile = request
        .credentials
        .or(saved)
        .ok_or("Enter your account or save a login first.")?;
    profile.character_slot = request.character_slot;
    if let Some(mode) = request.mode {
        profile.mode = mode;
    }
    profile.auto_login = request.auto_login;
    profile.validate()?;
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn profile(username: &str) -> LoginProfile {
        serde_json::from_value(json!({"username":username,"password":"synthetic-password",
            "characterSlot":0,"mode":"gameClient","autoLogin":false}))
        .unwrap()
    }
    fn request(credentials: Option<LoginProfile>) -> LoginRequest {
        LoginRequest {
            mode: Some(ConnectionMode::BotOnly),
            credentials,
            character_slot: 2,
            remember: true,
            auto_login: true,
        }
    }

    #[test]
    fn explicit_credentials_take_precedence_and_request_fields_apply_to_either_source() {
        let explicit =
            resolve_profile(request(Some(profile("explicit"))), Some(profile("saved"))).unwrap();
        assert_eq!(explicit.username, "explicit");
        for resolved in [
            explicit,
            resolve_profile(request(None), Some(profile("saved"))).unwrap(),
        ] {
            assert_eq!(resolved.character_slot, 2);
            assert_eq!(resolved.mode, ConnectionMode::BotOnly);
            assert!(resolved.auto_login);
        }
    }

    #[test]
    fn missing_profiles_invalid_credentials_and_unsaved_auto_login_reject() {
        assert!(resolve_profile(request(None), None).is_err());
        assert!(resolve_profile(request(Some(profile(" "))), None).is_err());
        let mut unsaved = request(None);
        unsaved.remember = false;
        assert!(validate_request(&unsaved).is_err());
        assert!(resolve_profile(unsaved, Some(profile("saved"))).is_err());
        let account = UpdateAccount::from_profile(&profile("saved"));
        let value = serde_json::to_value(account).unwrap();
        assert!(value.get("password").is_none());
        assert!(value.get("autoLogin").is_none());
    }
}
