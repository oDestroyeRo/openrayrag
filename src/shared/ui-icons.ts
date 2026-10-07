import { map as mapRecord } from 'effect/Record';
import activity from '@tabler/icons/outline/activity.svg?raw';
import adjustments from '@tabler/icons/outline/adjustments-horizontal.svg?raw';
import tool from '@tabler/icons/outline/tool.svg?raw';
import settings from '@tabler/icons/outline/settings.svg?raw';
import play from '@tabler/icons/outline/player-play.svg?raw';
import stop from '@tabler/icons/outline/player-stop.svg?raw';
import plug from '@tabler/icons/outline/plug.svg?raw';
import pencil from '@tabler/icons/outline/pencil.svg?raw';

/** Official Tabler assets; their adjacent text supplies each control's name. */
const decorative = (svg: string): string => `<span class="client-icon" aria-hidden="true">${svg}</span>`;
export const UI_ICONS = mapRecord({ activity, adjustments, tool, settings, play, stop, plug, pencil }, decorative);
