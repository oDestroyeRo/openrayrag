//! Deterministic close-save lifecycle. Tokens and native shutdown enter from orchestration.
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct Request {
    pub(crate) token: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Intent {
    Close,
    Quit(i32),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) enum Lifecycle {
    #[default]
    Unregistered,
    Ready,
    Pending {
        request: Request,
        intent: Intent,
    },
    Completing,
}

pub(crate) enum RequestPlan {
    Allow,
    GenerateToken(Intent),
    Reuse { request: Request, intent: Intent },
}

pub(crate) struct Completion<'a> {
    pub(crate) token: &'a str,
    pub(crate) saved_revision: Option<u64>,
    pub(crate) revision: u64,
}

#[derive(Debug, PartialEq)]
pub(crate) enum CompletionError {
    RevisionMismatch,
    RequestMismatch,
}

pub(crate) fn exit_intent(code: Option<i32>, restart_code: i32) -> Option<Intent> {
    (code != Some(restart_code)).then_some(Intent::Quit(code.unwrap_or(0)))
}

impl Lifecycle {
    pub(crate) fn register(&self) -> Self {
        match self {
            Self::Unregistered => Self::Ready,
            _ => self.clone(),
        }
    }

    pub(crate) fn pending_request(&self) -> Option<Request> {
        match self {
            Self::Pending { request, .. } => Some(request.clone()),
            _ => None,
        }
    }

    pub(crate) fn request_plan(&self, intent: Intent) -> RequestPlan {
        // An unregistered controller has no editable draft. A completing
        // shutdown must not start another handshake.
        match self {
            Self::Unregistered | Self::Completing => RequestPlan::Allow,
            Self::Ready => RequestPlan::GenerateToken(intent),
            Self::Pending {
                request,
                intent: current,
            } => RequestPlan::Reuse {
                request: request.clone(),
                intent: if matches!(intent, Intent::Quit(_)) {
                    intent
                } else {
                    *current
                },
            },
        }
    }

    pub(crate) fn pending(request: Request, intent: Intent) -> Self {
        Self::Pending { request, intent }
    }

    pub(crate) fn cancel(&self, token: &str) -> Self {
        match self {
            Self::Pending { request, .. } if request.token == token => Self::Ready,
            _ => self.clone(),
        }
    }

    pub(crate) fn complete(
        &self,
        confirmation: Completion<'_>,
    ) -> Result<(Self, Intent), CompletionError> {
        // Saved revision has always had precedence over token ownership.
        if confirmation.saved_revision != Some(confirmation.revision) {
            return Err(CompletionError::RevisionMismatch);
        }
        match self {
            Self::Pending { request, intent } if request.token == confirmation.token => {
                Ok((Self::Completing, *intent))
            }
            _ => Err(CompletionError::RequestMismatch),
        }
    }

    pub(crate) fn completion_failed(&self) -> Self {
        match self {
            Self::Completing => Self::Ready,
            _ => self.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(token: &str, intent: Intent) -> Lifecycle {
        Lifecycle::pending(
            Request {
                token: token.into(),
            },
            intent,
        )
    }

    fn confirmation(token: &str, saved_revision: Option<u64>, revision: u64) -> Completion<'_> {
        Completion {
            token,
            saved_revision,
            revision,
        }
    }

    #[test]
    fn registration_and_completion_have_no_contradictory_states() {
        let startup = Lifecycle::default();
        assert!(matches!(
            startup.request_plan(Intent::Close),
            RequestPlan::Allow
        ));
        assert!(matches!(
            startup.request_plan(Intent::Quit(0)),
            RequestPlan::Allow
        ));
        assert_eq!(startup.register(), Lifecycle::Ready);
        assert_eq!(startup, Lifecycle::Unregistered);
        assert!(matches!(
            Lifecycle::Ready.request_plan(Intent::Close),
            RequestPlan::GenerateToken(Intent::Close)
        ));
        let state = pending("owned", Intent::Close);
        assert_eq!(state.register(), state);
        let (completed, intent) = state.complete(confirmation("owned", Some(1), 1)).unwrap();
        assert_eq!(intent, Intent::Close);
        assert_eq!(completed, Lifecycle::Completing);
        assert_eq!(completed.register(), Lifecycle::Completing);
        assert!(completed.pending_request().is_none());
        assert!(matches!(
            completed.request_plan(Intent::Quit(7)),
            RequestPlan::Allow
        ));
        assert_eq!(
            completed.complete(confirmation("owned", Some(1), 1)),
            Err(CompletionError::RequestMismatch)
        );
        assert_eq!(state, pending("owned", Intent::Close));
    }

    #[test]
    fn duplicate_requests_reuse_the_token_and_latest_quit_promotes_close() {
        let mut state = pending("owned", Intent::Close);
        for (requested, expected) in [
            (Intent::Close, Intent::Close),
            (Intent::Quit(7), Intent::Quit(7)),
            (Intent::Close, Intent::Quit(7)),
            (Intent::Quit(9), Intent::Quit(9)),
        ] {
            let RequestPlan::Reuse { request, intent } = state.request_plan(requested) else {
                panic!("pending request must reuse its token");
            };
            assert_eq!(request.token, "owned");
            assert_eq!(intent, expected);
            state = Lifecycle::pending(request, intent);
        }
        assert_eq!(
            serde_json::to_value(state.pending_request().unwrap()).unwrap(),
            serde_json::json!({"token":"owned"})
        );
        assert_eq!(
            state.complete(confirmation("owned", Some(2), 2)).unwrap().1,
            Intent::Quit(9)
        );
    }

    #[test]
    fn saved_revision_errors_precede_token_errors_and_do_not_change_pending_authority() {
        let state = pending("owned", Intent::Quit(0));
        for saved in [None, Some(1)] {
            for token in ["owned", "unknown"] {
                assert_eq!(
                    state.complete(confirmation(token, saved, 2)),
                    Err(CompletionError::RevisionMismatch)
                );
            }
        }
        assert_eq!(
            state.complete(confirmation("unknown", Some(2), 2)),
            Err(CompletionError::RequestMismatch)
        );
        assert_eq!(
            state.complete(confirmation("owned", Some(2), 2)).unwrap(),
            (Lifecycle::Completing, Intent::Quit(0))
        );
        assert_eq!(state, pending("owned", Intent::Quit(0)));
    }

    #[test]
    fn cancel_and_failed_native_close_allow_only_a_fresh_handshake() {
        let state = pending("owned", Intent::Close);
        assert_eq!(state.cancel("unknown"), state);
        assert_eq!(state.cancel("owned"), Lifecycle::Ready);
        assert_eq!(Lifecycle::Completing.completion_failed(), Lifecycle::Ready);
        assert_eq!(state.completion_failed(), state);
        let retry = pending("retry", Intent::Quit(0));
        assert_eq!(
            retry.complete(confirmation("owned", Some(1), 1)),
            Err(CompletionError::RequestMismatch)
        );
        assert_eq!(
            retry.complete(confirmation("retry", Some(1), 1)).unwrap().1,
            Intent::Quit(0)
        );
    }

    #[test]
    fn restart_bypass_does_not_create_a_quit_intent() {
        assert_eq!(exit_intent(Some(42), 42), None);
        assert_eq!(exit_intent(None, 42), Some(Intent::Quit(0)));
        assert_eq!(exit_intent(Some(7), 42), Some(Intent::Quit(7)));
    }
}
