//! Requested CSS view bounds, automatic content inset policy and native clipping.
use crate::shared::domain_values::{ClippedViewExtent, RequestedViewExtent, ViewOrigin};
use frunk::{hlist_pat, prelude::IntoValidated};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct GameViewBounds {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ClippedViewBounds {
    x: ViewOrigin,
    y: ViewOrigin,
    width: ClippedViewExtent,
    height: ClippedViewExtent,
}
impl ClippedViewBounds {
    pub(crate) fn raw(self) -> GameViewBounds {
        GameViewBounds {
            x: self.x.get(),
            y: self.y.get(),
            width: self.width.get(),
            height: self.height.get(),
        }
    }
}

pub(crate) fn parked_x(width: f64) -> Result<f64, String> {
    if !width.is_finite() || width < 1.0 {
        return Err("Game view size unavailable.".into());
    }
    // The right edge stays left of the client area even when the window grows.
    Ok(-width - 1.0)
}

impl GameViewBounds {
    pub(crate) fn clipped(
        self,
        width: f64,
        height: f64,
        top_inset: f64,
    ) -> Result<ClippedViewBounds, String> {
        if ![
            self.x,
            self.y,
            self.width,
            self.height,
            width,
            height,
            top_inset,
        ]
        .iter()
        .all(|value| value.is_finite())
        {
            return Err("Invalid game view bounds.".into());
        }
        if top_inset < 0.0 || self.y < 0.0 {
            return Err("Invalid game view bounds.".into());
        }
        (ViewOrigin::try_from((self.x, width)).into_validated()
            + ViewOrigin::try_from((self.y + top_inset, height))
            + RequestedViewExtent::try_from(self.width)
            + RequestedViewExtent::try_from(self.height))
        .into_result()
        .map_err(|_| "Invalid game view bounds.")
        .and_then(|hlist_pat!(x, y, requested_width, requested_height)| {
            Ok(ClippedViewBounds {
                x,
                y,
                width: ClippedViewExtent::clip(requested_width, width - x.get())
                    .map_err(|_| "Invalid game view bounds.")?,
                height: ClippedViewExtent::clip(requested_height, height - y.get())
                    .map_err(|_| "Invalid game view bounds.")?,
            })
        })
        .map_err(|_| "Invalid game view bounds.".into())
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy)]
pub(crate) struct AutomaticInsetContext {
    pub full_size_content: bool,
    pub transparent_titlebar: bool,
    pub enclosing_scroll_view: bool,
    pub content_layout_top: f64,
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn automatic_inset_enabled(context: AutomaticInsetContext) -> bool {
    context.full_size_content && !context.transparent_titlebar && !context.enclosing_scroll_view
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn automatic_top_inset(context: AutomaticInsetContext) -> Result<f64, String> {
    if !automatic_inset_enabled(context) {
        return Ok(0.0);
    }
    if !context.content_layout_top.is_finite() {
        return Err("Game view content origin unavailable.".into());
    }
    Ok(context.content_layout_top.max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_bounds_follow_the_automatic_content_origin_without_resizing_the_game() {
        let inset = automatic_top_inset(AutomaticInsetContext {
            full_size_content: true,
            transparent_titlebar: false,
            enclosing_scroll_view: false,
            content_layout_top: 28.0,
        })
        .unwrap();
        let css = GameViewBounds {
            x: 24.0,
            y: 145.0,
            width: 1052.0,
            height: 646.984375,
        };
        assert_eq!(
            css.clipped(1100.0, 880.0, inset).unwrap().raw(),
            GameViewBounds {
                x: 24.0,
                y: 173.0,
                width: 1052.0,
                height: 646.984375,
            }
        );
    }

    #[test]
    fn only_webkits_automatic_inset_conditions_change_the_css_origin() {
        for full_size_content in [false, true] {
            for transparent_titlebar in [false, true] {
                for enclosing_scroll_view in [false, true] {
                    let context = AutomaticInsetContext {
                        full_size_content,
                        transparent_titlebar,
                        enclosing_scroll_view,
                        content_layout_top: 36.5,
                    };
                    let expected =
                        if full_size_content && !transparent_titlebar && !enclosing_scroll_view {
                            36.5
                        } else {
                            0.0
                        };
                    assert_eq!(automatic_top_inset(context).unwrap(), expected);
                }
            }
        }
    }

    #[test]
    fn content_below_the_titlebar_has_no_inset_and_missing_evidence_cannot_show_game() {
        let context = AutomaticInsetContext {
            full_size_content: true,
            transparent_titlebar: false,
            enclosing_scroll_view: false,
            content_layout_top: -145.0,
        };
        assert_eq!(automatic_top_inset(context).unwrap(), 0.0);
        for content_layout_top in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(automatic_top_inset(AutomaticInsetContext {
                content_layout_top,
                ..context
            })
            .is_err());
            assert_eq!(
                automatic_top_inset(AutomaticInsetContext {
                    full_size_content: false,
                    content_layout_top,
                    ..context
                })
                .unwrap(),
                0.0
            );
        }
    }

    #[test]
    fn translated_bounds_clip_after_projection_and_preserve_fractional_room() {
        let css = GameViewBounds {
            x: 99.75,
            y: 21.5,
            width: 10.0,
            height: 10.0,
        };
        assert_eq!(
            css.clipped(100.0, 50.0, 28.0).unwrap().raw(),
            GameViewBounds {
                x: 99.75,
                y: 49.5,
                width: 0.25,
                height: 0.5,
            }
        );
        assert_eq!(css.y, 21.5);
        assert!(css.clipped(100.0, 49.5, 28.0).is_err());
        for top_inset in [-1.0, f64::NAN, f64::INFINITY] {
            assert!(css.clipped(100.0, 50.0, top_inset).is_err());
        }
        // An inset cannot make a malformed CSS origin look valid.
        assert!(GameViewBounds { y: -1.0, ..css }
            .clipped(100.0, 50.0, 28.0)
            .is_err());
        assert!(GameViewBounds { height: 0.5, ..css }
            .clipped(100.0, 50.0, 28.0)
            .is_err());
        assert!(GameViewBounds { y: f64::MAX, ..css }
            .clipped(100.0, f64::MAX, f64::MAX)
            .is_err());
    }
}
