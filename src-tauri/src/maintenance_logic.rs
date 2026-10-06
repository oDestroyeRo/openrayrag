//! Raw game identity observation/transport schema. Continuation admission owns
//! its stricter checked identity view; bridge observations retain their contract.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GameIdentity {
    pub session_id: String,
    pub connection_id: String,
}
