use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GameIdentity {
    pub session_id: String,
    pub connection_id: String,
}
#[derive(Clone)]
pub(crate) struct Lease {
    pub nonce: String,
    pub until: Instant,
    pub revision: u64,
    pub game_generation: u64,
    pub identity: Option<GameIdentity>,
    pub acknowledged: bool,
    pub committed: bool,
    pub form_revision: u64,
    pub bridge_revision: Option<u64>,
    pub final_requested: bool,
    pub final_ack: bool,
    pub invalidated: bool,
}
#[derive(Clone, PartialEq)]
pub(crate) struct GameRetirement {
    nonce: String,
    game_generation: u64,
    identity: Option<GameIdentity>,
}
struct Retirement {
    owner: GameRetirement,
    transport_joined: bool,
    close_requested: bool,
    destroyed: bool,
}
#[derive(Default)]
struct PageLifetime {
    seen: AtomicBool,
    held: AtomicBool,
}
impl PageLifetime {
    fn navigation(&self) {
        if self.seen.swap(true, Ordering::SeqCst) {
            self.held.store(true, Ordering::SeqCst);
        }
    }
    fn closed(&self) {
        if self.seen.load(Ordering::SeqCst) {
            self.held.store(true, Ordering::SeqCst);
        }
    }
}
#[derive(Default)]
pub(crate) struct Gate {
    pub lease: Option<Lease>,
    pub revision: u64,
    pub game_generation: u64,
    pub ever_game: bool,
    pub identity: Option<GameIdentity>,
    pub observed: Option<Instant>,
    pub initialized: bool,
    pub form_revision: Option<u64>,
    retirement: Option<Retirement>,
    navigation_authorized: Arc<AtomicBool>,
    page: Arc<PageLifetime>,
}
pub(crate) struct SharedGate {
    gate: Mutex<Gate>,
    navigation_authorized: Arc<AtomicBool>,
    page: Arc<PageLifetime>,
}
impl Default for SharedGate {
    fn default() -> Self {
        let navigation_authorized = Arc::new(AtomicBool::new(false));
        let page = Arc::new(PageLifetime::default());
        Self {
            gate: Mutex::new(Gate {
                navigation_authorized: navigation_authorized.clone(),
                page: page.clone(),
                ..Default::default()
            }),
            navigation_authorized,
            page,
        }
    }
}
impl std::ops::Deref for SharedGate {
    type Target = Mutex<Gate>;
    fn deref(&self) -> &Self::Target {
        &self.gate
    }
}
impl SharedGate {
    /// Only an already-admitted native create/reconnect may navigate while its
    /// admission lock is held. A lease cannot coexist with this one-shot permit.
    pub fn page_held(&self) -> bool {
        self.page.held.load(Ordering::SeqCst)
    }
    pub fn take_authorized_navigation(&self) -> bool {
        self.navigation_authorized.swap(false, Ordering::SeqCst)
    }
}
impl Gate {
    fn committed_for(&self, nonce: &str) -> bool {
        self.lease.as_ref().is_some_and(|l| {
            l.nonce == nonce
                && l.committed
                && !l.invalidated
                && l.acknowledged
                && (l.identity.is_none() || l.final_ack)
                && l.revision == self.revision
                && l.game_generation == self.game_generation
                && l.identity == self.identity
                && self.form_revision == Some(l.form_revision)
        })
    }
    pub fn begin_retirement(
        &mut self,
        nonce: &str,
        has_game: bool,
    ) -> Result<GameRetirement, String> {
        if !self.committed_for(nonce)
            || self.retirement.is_some()
            || has_game != self.identity.is_some()
        {
            return Err("Game settlement changed before retirement.".into());
        }
        let owner = GameRetirement {
            nonce: nonce.to_owned(),
            game_generation: self.game_generation,
            identity: self.identity.clone(),
        };
        self.retirement = Some(Retirement {
            owner: owner.clone(),
            transport_joined: false,
            close_requested: false,
            destroyed: !has_game,
        });
        Ok(owner)
    }
    fn retirement_matches(&self, owner: &GameRetirement) -> bool {
        self.committed_for(&owner.nonce)
            && self.game_generation == owner.game_generation
            && self.identity == owner.identity
            && self.retirement.as_ref().is_some_and(|r| r.owner == *owner)
    }
    pub fn transport_retired(&mut self, owner: &GameRetirement) -> Result<(), String> {
        if !self.retirement_matches(owner) {
            return Err("Game settlement changed during retirement.".into());
        }
        self.retirement.as_mut().unwrap().transport_joined = true;
        Ok(())
    }
    pub fn request_game_close(&mut self, owner: &GameRetirement) -> Result<(), String> {
        if !self.retirement_matches(owner)
            || !self
                .retirement
                .as_ref()
                .is_some_and(|r| r.transport_joined && !r.close_requested && !r.destroyed)
        {
            return Err("Game settlement changed before close.".into());
        }
        self.retirement.as_mut().unwrap().close_requested = true;
        Ok(())
    }
    pub fn updater_game_destroyed(&mut self) -> bool {
        let Some(r) = self.retirement.as_ref() else {
            return false;
        };
        if !r.transport_joined
            || !r.close_requested
            || r.destroyed
            || !self.retirement_matches(&r.owner)
        {
            return false;
        }
        self.retirement.as_mut().unwrap().destroyed = true;
        true
    }
    pub fn replacement_ready(&self, owner: &GameRetirement) -> bool {
        self.retirement_matches(owner)
            && self
                .retirement
                .as_ref()
                .is_some_and(|r| r.transport_joined && r.destroyed)
    }
    pub fn game_closed(&mut self) {
        self.retirement = None;
        self.page_closed();
        self.game_generation += 1;
        self.identity = None;
        if let Some(nonce) = self.lease.as_ref().map(|l| l.nonce.clone()) {
            self.invalidate(&nonce);
        }
    }
    pub fn release_retirement(&mut self, owner: &GameRetirement) {
        if self.retirement.as_ref().is_some_and(|r| r.owner == *owner) {
            self.retirement = None;
        }
        if self.lease.as_ref().is_some_and(|l| l.nonce == owner.nonce) {
            self.lease = None;
        }
    }
    pub fn authorize_navigation(&mut self) {
        if self.lease.is_some() {
            return;
        }
        self.page.navigation();
        self.identity = None;
        self.game_generation += 1;
        self.navigation_authorized.store(true, Ordering::SeqCst);
    }
    pub fn page_navigation(&self) {
        self.page.navigation();
    }
    pub fn page_closed(&self) {
        self.page.closed();
    }
    pub fn cancel_navigation(&self) {
        self.navigation_authorized.store(false, Ordering::SeqCst);
    }

    pub fn expire(&mut self) {
        if self
            .lease
            .as_ref()
            .is_some_and(|l| !l.committed && Instant::now() >= l.until)
        {
            self.lease = None;
        }
    }
    pub fn admit(&mut self) -> Result<(), String> {
        self.expire();
        if self.lease.is_some() {
            return Err("Client update is settling. Try again shortly.".into());
        }
        self.revision += 1;
        Ok(())
    }
    pub fn reserve(
        &mut self,
        nonce: String,
        form_revision: u64,
        has_game: bool,
    ) -> Result<(), String> {
        self.expire();
        if self.page.held.load(Ordering::SeqCst) {
            return Err("Update waits because a replaced game page may have unresolved actions. Quit and reopen Companion when safe, or use the release download.".into());
        }
        if self.lease.is_some()
            || self.navigation_authorized.load(Ordering::SeqCst)
            || !self.initialized
            || self.form_revision != Some(form_revision)
            || !has_game && self.ever_game
            || has_game
                && (self.identity.is_none()
                    || self
                        .observed
                        .map_or(true, |t| t.elapsed() > Duration::from_secs(2)))
        {
            return Err("Waiting for a fresh stopped client before updating.".into());
        }
        self.lease = Some(Lease {
            nonce,
            until: Instant::now() + Duration::from_secs(4),
            revision: self.revision,
            game_generation: self.game_generation,
            identity: if has_game {
                self.identity.clone()
            } else {
                None
            },
            acknowledged: !has_game,
            committed: false,
            form_revision,
            bridge_revision: None,
            final_requested: false,
            final_ack: false,
            invalidated: false,
        });
        Ok(())
    }
    pub fn acknowledge(&mut self, nonce: &str, identity: GameIdentity, revision: u64) -> bool {
        self.expire();
        let Some(l) = self.lease.as_mut() else {
            return false;
        };
        if l.committed
            || l.acknowledged
            || l.nonce != nonce
            || l.revision != self.revision
            || l.game_generation != self.game_generation
            || l.identity.as_ref() != Some(&identity)
            || self.identity.as_ref() != Some(&identity)
            || revision > 9_007_199_254_740_991
        {
            return false;
        }
        l.acknowledged = true;
        l.bridge_revision = Some(revision);
        true
    }
    pub fn invalidate(&mut self, nonce: &str) {
        if let Some(l) = self.lease.as_mut() {
            if l.nonce == nonce {
                l.invalidated = true;
                l.acknowledged = false;
                l.final_ack = false;
            }
        }
    }
    pub fn final_ack(&mut self, nonce: &str, identity: &GameIdentity, revision: u64) -> bool {
        self.expire();
        let Some(l) = self.lease.as_mut() else {
            return false;
        };
        if l.committed
            || l.invalidated
            || !l.acknowledged
            || !l.final_requested
            || l.nonce != nonce
            || l.identity.as_ref() != Some(identity)
            || l.bridge_revision != Some(revision)
            || l.game_generation != self.game_generation
            || l.identity != self.identity
        {
            return false;
        }
        l.final_ack = true;
        true
    }
    pub fn commit(&mut self, nonce: &str) -> Result<(), String> {
        self.expire();
        let l = self.lease.as_mut().ok_or("Update settlement expired.")?;
        if l.committed
            || l.invalidated
            || l.identity.is_some() && !l.final_ack
            || l.nonce != nonce
            || !l.acknowledged
            || l.revision != self.revision
            || l.game_generation != self.game_generation
            || l.identity != self.identity && l.identity.is_some()
            || self.form_revision != Some(l.form_revision)
        {
            return Err("Update settlement changed.".into());
        }
        l.committed = true;
        Ok(())
    }
}
pub(crate) fn admit(app: &tauri::AppHandle) -> Result<MutexGuard<'_, Gate>, String> {
    use tauri::Manager;
    let mut gate = app
        .state::<SharedGate>()
        .inner()
        .lock()
        .map_err(|_| "Update state unavailable.")?;
    gate.admit()?;
    Ok(gate)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn gate() -> Gate {
        Gate {
            initialized: true,
            form_revision: Some(3),
            ..Default::default()
        }
    }
    #[test]
    fn startup_requires_initialization_and_never_opened_game() {
        let mut g = gate();
        g.initialized = false;
        assert!(g.reserve("x".into(), 3, false).is_err());
        g.initialized = true;
        g.ever_game = true;
        assert!(g.reserve("x".into(), 3, false).is_err());
        g.ever_game = false;
        g.reserve("x".into(), 3, false).unwrap();
        assert!(g.admit().is_err());
        g.commit("x").unwrap();
        g.lease.as_mut().unwrap().until = Instant::now();
        g.expire();
        assert!(g.admit().is_err());
    }
    #[test]
    fn stale_duplicate_changed_or_expired_ack_never_commits() {
        let mut g = gate();
        let i = GameIdentity {
            session_id: "page".into(),
            connection_id: "socket".into(),
        };
        g.identity = Some(i.clone());
        g.observed = Some(Instant::now());
        g.reserve("x".into(), 3, true).unwrap();
        assert!(!g.acknowledge("old", i.clone(), 0));
        assert!(g.acknowledge("x", i.clone(), 0));
        assert!(!g.acknowledge("x", i, 0));
        g.game_generation += 1;
        assert!(g.commit("x").is_err());
        g.lease.as_mut().unwrap().until = Instant::now();
        g.expire();
        assert!(g.lease.is_none());
    }
    #[test]
    fn post_ack_changes_and_duplicate_installs_reject() {
        let mut g = gate();
        let i = GameIdentity {
            session_id: "page".into(),
            connection_id: "socket".into(),
        };
        g.identity = Some(i.clone());
        g.observed = Some(Instant::now());
        g.reserve("x".into(), 3, true).unwrap();
        assert!(g.acknowledge("x", i.clone(), 4));
        g.lease.as_mut().unwrap().final_requested = true;
        assert!(g.final_ack("x", &i, 4));
        g.invalidate("x");
        assert!(g.commit("x").is_err());
        g.lease = None;
        g.reserve("y".into(), 3, true).unwrap();
        g.acknowledge("y", i.clone(), 4);
        g.lease.as_mut().unwrap().final_requested = true;
        assert!(!g.final_ack("y", &i, 5));
        assert!(g.final_ack("y", &i, 4));
        g.commit("y").unwrap();
        assert!(g.commit("y").is_err());
        assert!(g.admit().is_err());
    }
    #[test]
    fn contended_navigation_requires_an_admitted_one_shot_owner() {
        let shared = SharedGate::default();
        let mut g = shared.lock().unwrap();
        assert!(shared.try_lock().is_err());
        assert!(!shared.take_authorized_navigation());
        g.initialized = true;
        g.form_revision = Some(3);
        g.authorize_navigation();
        assert!(g.reserve("x".into(), 3, false).is_err());
        assert!(shared.take_authorized_navigation());
        assert!(!shared.take_authorized_navigation());
        // Native initialization, not navigation permission, must provide a
        // new identity before any connected-game lease can be admitted.
        assert!(g.reserve("x".into(), 3, true).is_err());
        g.reserve("x".into(), 3, false).unwrap();
        assert!(!shared.take_authorized_navigation());
        g.commit("x").unwrap();
        assert!(!shared.take_authorized_navigation());
    }
    #[test]
    fn initial_page_is_eligible_but_replacement_hold_survives_clean_status() {
        for replacement in [0, 1, 2] {
            let shared = SharedGate::default();
            let mut g = shared.lock().unwrap();
            g.initialized = true;
            g.form_revision = Some(3);
            g.authorize_navigation();
            assert!(shared.take_authorized_navigation());
            assert!(!shared.page_held());
            let i = GameIdentity {
                session_id: "first".into(),
                connection_id: "socket".into(),
            };
            g.identity = Some(i);
            g.observed = Some(Instant::now());
            g.reserve("before".into(), 3, true).unwrap();
            g.lease = None;
            // Replacement is held even before a native ready status was ever
            // published; only page/window lifecycle, not actor readiness, counts.
            g.identity = None;
            match replacement {
                0 => g.page_navigation(),
                1 => {
                    g.authorize_navigation();
                    assert!(shared.take_authorized_navigation());
                }
                _ => g.page_closed(),
            }
            assert!(shared.page_held());
            g.identity = Some(GameIdentity {
                session_id: "new".into(),
                connection_id: "fresh".into(),
            });
            g.observed = Some(Instant::now());
            assert!(g.reserve("after".into(), 3, true).is_err());
            g.identity = None;
            assert!(g.reserve("offline".into(), 3, false).is_err());
            // Only a new process/gate can have a fresh startup lifecycle.
            assert!(!SharedGate::default().page_held());
        }
    }
    #[test]
    fn replacement_before_any_ready_publish_already_holds_installation() {
        let shared = SharedGate::default();
        let mut g = shared.lock().unwrap();
        g.initialized = true;
        g.form_revision = Some(3);
        g.authorize_navigation();
        assert!(shared.take_authorized_navigation());
        assert!(g.identity.is_none());
        g.authorize_navigation();
        assert!(shared.take_authorized_navigation());
        assert!(shared.page_held());
        g.identity = Some(GameIdentity {
            session_id: "new".into(),
            connection_id: "fresh".into(),
        });
        g.observed = Some(Instant::now());
        assert!(g.reserve("after".into(), 3, true).is_err());
    }
    #[test]
    fn changed_form_cannot_use_an_old_ack() {
        let mut g = gate();
        g.reserve("x".into(), 3, false).unwrap();
        g.form_revision = Some(4);
        assert!(g.commit("x").is_err());
    }
}
