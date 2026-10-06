//! Checked values shared by native policy owners. Raw serde DTOs stay at the boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ValueError {
    AccountName,
    Password,
    CharacterSlot,
    FormVersion,
    FormRevision,
    ProfileId,
    CloseToken,
    ItemId,
    BagId,
    ActorId,
    ItemCount,
    Percentage,
    RecoveryTimeout,
    ViewOrigin,
    ViewExtent,
    UpdateRequestId,
    SessionId,
    ConnectionId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct UpdateRequestId<'a>(&'a str);
impl<'a> TryFrom<&'a str> for UpdateRequestId<'a> {
    type Error = ValueError;
    fn try_from(value: &'a str) -> Result<Self, Self::Error> {
        (value.len() == 32
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .then_some(Self(value))
        .ok_or(ValueError::UpdateRequestId)
    }
}

fn continuation_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SessionId<'a>(&'a str);
impl<'a> TryFrom<&'a str> for SessionId<'a> {
    type Error = ValueError;
    fn try_from(value: &'a str) -> Result<Self, Self::Error> {
        continuation_identity(value)
            .then_some(Self(value))
            .ok_or(ValueError::SessionId)
    }
}
impl SessionId<'_> {
    pub(crate) fn as_str(&self) -> &str {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ConnectionId<'a>(&'a str);
impl<'a> TryFrom<&'a str> for ConnectionId<'a> {
    type Error = ValueError;
    fn try_from(value: &'a str) -> Result<Self, Self::Error> {
        continuation_identity(value)
            .then_some(Self(value))
            .ok_or(ValueError::ConnectionId)
    }
}
impl ConnectionId<'_> {
    pub(crate) fn as_str(&self) -> &str {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ViewOrigin(f64);
impl TryFrom<(f64, f64)> for ViewOrigin {
    type Error = ValueError;
    fn try_from((value, parent): (f64, f64)) -> Result<Self, Self::Error> {
        (value.is_finite() && parent.is_finite() && value >= 0.0 && value < parent)
            .then_some(Self(value))
            .ok_or(ValueError::ViewOrigin)
    }
}
impl ViewOrigin {
    pub(crate) fn get(self) -> f64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RequestedViewExtent(f64);
impl TryFrom<f64> for RequestedViewExtent {
    type Error = ValueError;
    fn try_from(value: f64) -> Result<Self, Self::Error> {
        (value.is_finite() && value >= 1.0)
            .then_some(Self(value))
            .ok_or(ValueError::ViewExtent)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ClippedViewExtent(f64);
impl ClippedViewExtent {
    pub(crate) fn clip(requested: RequestedViewExtent, remaining: f64) -> Result<Self, ValueError> {
        (remaining.is_finite() && remaining > 0.0)
            .then_some(Self(requested.0.min(remaining)))
            .ok_or(ValueError::ViewExtent)
    }
    pub(crate) fn get(self) -> f64 {
        self.0
    }
}

// These domains deliberately have different zero policies, even though all
// three use signed JSON integers at the request boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ItemId(i64);
impl TryFrom<i64> for ItemId {
    type Error = ValueError;
    fn try_from(value: i64) -> Result<Self, Self::Error> {
        (1..=i64::from(i32::MAX))
            .contains(&value)
            .then_some(Self(value))
            .ok_or(ValueError::ItemId)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct BagId(i64);
impl TryFrom<i64> for BagId {
    type Error = ValueError;
    fn try_from(value: i64) -> Result<Self, Self::Error> {
        (1..=i64::from(i32::MAX))
            .contains(&value)
            .then_some(Self(value))
            .ok_or(ValueError::BagId)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ActorId(i64);
impl TryFrom<i64> for ActorId {
    type Error = ValueError;
    fn try_from(value: i64) -> Result<Self, Self::Error> {
        (0..=i64::from(i32::MAX))
            .contains(&value)
            .then_some(Self(value))
            .ok_or(ValueError::ActorId)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ItemCount(i64);
impl TryFrom<i64> for ItemCount {
    type Error = ValueError;
    fn try_from(value: i64) -> Result<Self, Self::Error> {
        (1..=32767)
            .contains(&value)
            .then_some(Self(value))
            .ok_or(ValueError::ItemCount)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Percentage(u8);
impl TryFrom<u8> for Percentage {
    type Error = ValueError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        (value <= 100)
            .then_some(Self(value))
            .ok_or(ValueError::Percentage)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RecoveryTimeoutSeconds(u16);
impl TryFrom<u16> for RecoveryTimeoutSeconds {
    type Error = ValueError;
    fn try_from(value: u16) -> Result<Self, Self::Error> {
        (1..=3600)
            .contains(&value)
            .then_some(Self(value))
            .ok_or(ValueError::RecoveryTimeout)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AccountName<'a>(&'a str);
impl<'a> TryFrom<&'a str> for AccountName<'a> {
    type Error = ValueError;
    fn try_from(value: &'a str) -> Result<Self, Self::Error> {
        if value.trim().is_empty()
            || value.chars().count() > 64
            || value.chars().any(char::is_control)
        {
            return Err(ValueError::AccountName);
        }
        Ok(Self(value))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct OwnedAccountName(String);
impl TryFrom<String> for OwnedAccountName {
    type Error = ValueError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        AccountName::try_from(value.as_str())?;
        Ok(Self(value))
    }
}
impl OwnedAccountName {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

pub(crate) struct OwnedPassword(String);
impl std::fmt::Debug for OwnedPassword {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OwnedPassword([redacted])")
    }
}
impl TryFrom<String> for OwnedPassword {
    type Error = ValueError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Password::try_from(value.as_str())?;
        Ok(Self(value))
    }
}
impl OwnedPassword {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct Password<'a>(&'a str);
impl std::fmt::Debug for Password<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Password([redacted])")
    }
}
impl<'a> TryFrom<&'a str> for Password<'a> {
    type Error = ValueError;
    fn try_from(value: &'a str) -> Result<Self, Self::Error> {
        if value.is_empty() || value.len() > 256 || value.contains('\0') {
            return Err(ValueError::Password);
        }
        Ok(Self(value))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct CharacterSlot(u8);
impl TryFrom<u8> for CharacterSlot {
    type Error = ValueError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        (value <= 2)
            .then_some(Self(value))
            .ok_or(ValueError::CharacterSlot)
    }
}
impl TryFrom<usize> for CharacterSlot {
    type Error = ValueError;
    fn try_from(value: usize) -> Result<Self, Self::Error> {
        u8::try_from(value)
            .map_err(|_| ValueError::CharacterSlot)
            .and_then(Self::try_from)
    }
}
impl CharacterSlot {
    pub(crate) fn index(self) -> usize {
        usize::from(self.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FormVersion(u8);
impl TryFrom<u8> for FormVersion {
    type Error = ValueError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        (value == 1)
            .then_some(Self(value))
            .ok_or(ValueError::FormVersion)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct FormRevision(u64);
impl TryFrom<u64> for FormRevision {
    type Error = ValueError;
    fn try_from(value: u64) -> Result<Self, Self::Error> {
        (value <= 9_007_199_254_740_991)
            .then_some(Self(value))
            .ok_or(ValueError::FormRevision)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProfileId<'a>(&'a str);
impl<'a> TryFrom<&'a str> for ProfileId<'a> {
    type Error = ValueError;
    fn try_from(value: &'a str) -> Result<Self, Self::Error> {
        if value.is_empty()
            || value.len() > 64
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(ValueError::ProfileId);
        }
        Ok(Self(value))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CloseToken(String);
impl TryFrom<String> for CloseToken {
    type Error = ValueError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        let valid = value.len() == 36
            && value.bytes().enumerate().all(|(i, b)| {
                if matches!(i, 8 | 13 | 18 | 23) {
                    b == b'-'
                } else {
                    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                }
            });
        valid.then_some(Self(value)).ok_or(ValueError::CloseToken)
    }
}
impl CloseToken {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_values_keep_exact_identity_and_distinct_units() {
        assert_ne!(
            AccountName::try_from(" user").unwrap(),
            AccountName::try_from("user").unwrap()
        );
        assert!(AccountName::try_from(" ").is_err());
        assert!(AccountName::try_from("a\n").is_err());
        assert!(Password::try_from("😀".repeat(65).as_str()).is_err());
        assert_eq!(
            format!("{:?}", Password::try_from("secret").unwrap()),
            "Password([redacted])"
        );
        for raw in 0_u8..=2 {
            assert_eq!(
                CharacterSlot::try_from(raw).unwrap().index(),
                usize::from(raw)
            );
        }
        for raw in [3_usize, 256, usize::MAX] {
            assert_eq!(CharacterSlot::try_from(raw), Err(ValueError::CharacterSlot));
        }
        assert!(FormVersion::try_from(0).is_err());
        let max = FormRevision::try_from(9_007_199_254_740_991).unwrap();
        assert!(max > FormRevision::try_from(0).unwrap());
        assert_eq!(
            FormRevision::try_from(9_007_199_254_740_992),
            Err(ValueError::FormRevision)
        );
        for invalid in ["", "../profile", "é", "has space"] {
            assert!(ProfileId::try_from(invalid).is_err());
        }
    }

    #[test]
    fn close_identity_accepts_only_exact_canonical_tokens() {
        let token = "01234567-89ab-4def-8123-456789abcdef";
        assert_eq!(
            CloseToken::try_from(token.to_owned()).unwrap().as_str(),
            token
        );
        for invalid in [
            token.to_uppercase(),
            token.replace('-', ""),
            format!(" {token}"),
            "owned".into(),
        ] {
            assert_eq!(CloseToken::try_from(invalid), Err(ValueError::CloseToken));
        }
    }

    #[test]
    fn gameplay_units_and_continuation_channels_keep_their_existing_boundaries() {
        assert!(ActorId::try_from(0).is_ok());
        for value in [-1, i64::from(i32::MAX) + 1] {
            assert!(ActorId::try_from(value).is_err());
        }
        for value in [0, -1, i64::from(i32::MAX) + 1] {
            assert!(ItemId::try_from(value).is_err());
            assert!(BagId::try_from(value).is_err());
        }
        for value in [1, i64::from(i32::MAX)] {
            assert!(ItemId::try_from(value).is_ok());
            assert!(BagId::try_from(value).is_ok());
        }
        for value in [0, 32768] {
            assert!(ItemCount::try_from(value).is_err());
        }
        for value in [1, 32767] {
            assert!(ItemCount::try_from(value).is_ok());
        }
        assert!(Percentage::try_from(0).is_ok());
        assert!(Percentage::try_from(100).is_ok());
        assert!(Percentage::try_from(101).is_err());
        for value in [0, 3601] {
            assert!(RecoveryTimeoutSeconds::try_from(value).is_err());
        }
        assert!(RecoveryTimeoutSeconds::try_from(3600).is_ok());
        let token = "0123456789abcdef0123456789abcdef";
        assert!(UpdateRequestId::try_from(token).is_ok());
        assert!(UpdateRequestId::try_from(token.to_uppercase().as_str()).is_err());
        assert!(SessionId::try_from("Session-1").is_ok());
        assert!(ConnectionId::try_from("Connection-1").is_ok());
        for value in ["", "contains_space", "é"] {
            assert!(SessionId::try_from(value).is_err());
            assert!(ConnectionId::try_from(value).is_err());
        }
        assert_eq!(
            ClippedViewExtent::clip(RequestedViewExtent::try_from(1.0).unwrap(), 0.25)
                .unwrap()
                .get(),
            0.25
        );
        assert!(RequestedViewExtent::try_from(0.25).is_err());
        assert!(ViewOrigin::try_from((f64::NAN, 100.0)).is_err());
    }
}
