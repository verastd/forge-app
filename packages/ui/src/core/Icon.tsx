/**
 * Icon (handoff core/Icon.jsx). The handoff loads the Lucide UMD bundle at
 * runtime; per its README this port uses lucide-react instead, so icons ship
 * in the bundle and render on the server. Same contract: a kebab-case Lucide
 * name, stroke 2, round caps, `currentColor`, decorative unless `label`.
 */
import type { CSSProperties } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Bell,
  BellOff,
  BellRing,
  Bookmark,
  Building2,
  Calculator,
  ChartLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Filter,
  Flame,
  Gem,
  History,
  House,
  Info,
  Layers,
  ListFilter,
  Lock,
  LogIn,
  Map,
  MapPin,
  Menu,
  Minus,
  Monitor,
  Moon,
  MoveHorizontal,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Star,
  Sun,
  Timer,
  Trash2,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  User,
  Wallet,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** Every icon the Embers components and kit screens reference, by Lucide name. */
export const ICONS = {
  'arrow-down': ArrowDown,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  'arrow-up-down': ArrowUpDown,
  bell: Bell,
  'bell-off': BellOff,
  'bell-ring': BellRing,
  bookmark: Bookmark,
  'building-2': Building2,
  calculator: Calculator,
  'chart-line': ChartLine,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevrons-right': ChevronsRight,
  'circle-alert': CircleAlert,
  'circle-check': CircleCheck,
  'circle-x': CircleX,
  clock: Clock,
  copy: Copy,
  download: Download,
  'external-link': ExternalLink,
  filter: Filter,
  flame: Flame,
  gem: Gem,
  history: History,
  house: House,
  info: Info,
  layers: Layers,
  'list-filter': ListFilter,
  lock: Lock,
  'log-in': LogIn,
  map: Map,
  'map-pin': MapPin,
  menu: Menu,
  minus: Minus,
  monitor: Monitor,
  moon: Moon,
  'move-horizontal': MoveHorizontal,
  pause: Pause,
  play: Play,
  plus: Plus,
  radio: Radio,
  'refresh-cw': RefreshCw,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  star: Star,
  sun: Sun,
  timer: Timer,
  'trash-2': Trash2,
  'trending-down': TrendingDown,
  'trending-up': TrendingUp,
  'triangle-alert': TriangleAlert,
  user: User,
  wallet: Wallet,
  wrench: Wrench,
  x: X,
  zap: Zap,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  size?: number;
  label?: string;
  style?: CSSProperties;
}

export function Icon({ name, size = 16, label, style }: IconProps) {
  const Glyph = ICONS[name];
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      data-icon={name}
      style={{ display: 'inline-flex', width: size, height: size, flex: 'none', verticalAlign: '-0.15em', lineHeight: 0, ...style }}
    >
      <Glyph size={size} strokeWidth={2} absoluteStrokeWidth={false} aria-hidden="true" focusable="false" />
    </span>
  );
}
