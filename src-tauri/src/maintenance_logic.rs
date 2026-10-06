//! Verified game identity schema shared by admission and continuation policy.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GameIdentity {
    pub session_id: String,
    pub connection_id: String,
}
