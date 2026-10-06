//! Account schemas and login request policy, without saved-profile or UI effects.
use frunk::{
    hlist,
    labelled::{IntoLabelledGeneric, IntoUnlabelled},
    prelude::IntoValidated,
    HList, Validated,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionMode {
    BotOnly,
    #[default]
    GameClient,
}

#[derive(Clone, Deserialize, Serialize, frunk::LabelledGeneric)]
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

#[derive(Debug, PartialEq)]
enum LoginField {
    Username,
    Password,
    CharacterSlot,
}
type LoginValidation<'a> = Validated<HList!(&'a str, &'a str, u8), LoginField>;

fn username(value: &str) -> Result<&str, LoginField> {
    if value.trim().is_empty() || value.chars().count() > 64 || value.chars().any(char::is_control)
    {
        return Err(LoginField::Username);
    }
    Ok(value)
}
fn password(value: &str) -> Result<&str, LoginField> {
    if value.is_empty() || value.len() > 256 || value.contains('\0') {
        return Err(LoginField::Password);
    }
    Ok(value)
}
fn character_slot(value: u8) -> Result<u8, LoginField> {
    (value <= 2)
        .then_some(value)
        .ok_or(LoginField::CharacterSlot)
}

impl LoginProfile {
    fn validated_fields(&self) -> LoginValidation<'_> {
        // Independent, bounded checks may accumulate internally. IPC still
        // receives the existing single sanitized error, never credential data.
        username(&self.username).into_validated()
            + password(&self.password)
            + character_slot(self.character_slot)
    }
    pub(crate) fn validate(&self) -> Result<(), String> {
        self.validated_fields()
            .into_result()
            .map(|_| ())
            .map_err(|_| "Enter a username, password and character slot 1–3.".into())
    }
}

#[derive(Serialize, frunk::LabelledGeneric)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedLogin {
    pub(crate) mode: ConnectionMode,
    pub(crate) username: String,
    pub(crate) character_slot: u8,
    pub(crate) auto_login: bool,
}

/// Proven account metadata only; continuation storage never receives credentials.
#[derive(
    Clone, Debug, Deserialize, Serialize, PartialEq, Eq, frunk::Generic, frunk::LabelledGeneric,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateAccount {
    pub username: String,
    pub character_slot: u8,
    pub mode: ConnectionMode,
}
impl UpdateAccount {
    pub fn validate(&self) -> Result<(), String> {
        (username(&self.username).into_validated() + character_slot(self.character_slot))
            .into_result()
            .map(|_| ())
            .map_err(|_| "Update account is invalid.".into())
    }
    pub(crate) fn from_profile(profile: &LoginProfile) -> Self {
        // Sculpt the borrowed representation before copying fields. Password
        // and auto-login are excluded by the target schema and are never cloned.
        let (fields, _) = IntoLabelledGeneric::into(profile)
            .sculpt::<<&UpdateAccount as IntoLabelledGeneric>::Repr, _>();
        frunk::from_generic(fields.into_unlabelled().map(hlist![
            String::clone,
            |slot: &u8| *slot,
            |mode: &ConnectionMode| *mode
        ]))
    }
}

impl From<LoginProfile> for SavedLogin {
    fn from(profile: LoginProfile) -> Self {
        frunk::transform_from(profile)
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
    fn account_and_saved_login_projections_preserve_exact_redacted_wire_shapes() {
        for mode in [ConnectionMode::BotOnly, ConnectionMode::GameClient] {
            for auto_login in [false, true] {
                let mut source = profile("account");
                source.mode = mode;
                source.character_slot = 2;
                source.auto_login = auto_login;
                let before = serde_json::to_value(&source).unwrap();
                let account = UpdateAccount::from_profile(&source);
                assert_eq!(
                    serde_json::to_value(&account).unwrap(),
                    json!({"username":"account","characterSlot":2,"mode":mode})
                );
                assert_eq!(UpdateAccount::from_profile(&source), account);
                assert_eq!(serde_json::to_value(&source).unwrap(), before);
                assert_eq!(
                    serde_json::to_value(SavedLogin::from(source)).unwrap(),
                    json!({"username":"account","characterSlot":2,"mode":mode,
                        "autoLogin":auto_login})
                );
            }
        }
    }

    #[test]
    fn independent_login_failures_keep_sanitized_external_errors() {
        let mut invalid = profile("");
        invalid.password = "\0".into();
        invalid.character_slot = 3;
        assert_eq!(
            invalid.validated_fields().into_result().unwrap_err(),
            [
                LoginField::Username,
                LoginField::Password,
                LoginField::CharacterSlot
            ]
        );
        assert_eq!(
            invalid.validate().unwrap_err(),
            "Enter a username, password and character slot 1–3."
        );
        assert_eq!(
            UpdateAccount::from_profile(&invalid)
                .validate()
                .unwrap_err(),
            "Update account is invalid."
        );
    }

    #[test]
    fn login_field_limits_preserve_character_and_byte_units() {
        let mut valid = profile(&"😀".repeat(64));
        valid.password = "p".repeat(256);
        valid.character_slot = 2;
        assert!(valid.validate().is_ok());
        valid.username.push('😀');
        assert_eq!(username(&valid.username), Err(LoginField::Username));
        valid.password.push('p');
        assert_eq!(password(&valid.password), Err(LoginField::Password));
        for value in [" ", "account\n"] {
            assert_eq!(username(value), Err(LoginField::Username));
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
