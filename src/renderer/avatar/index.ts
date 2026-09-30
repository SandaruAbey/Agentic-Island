// Swap these two lines for `@bible-strong/avatar-react` (+ its styles.css) once that package is published —
// the API (createAvatar, props, AvatarController) is the same.
import { createAvatar } from './Avatar'
export type { AvatarController } from './Avatar'

import islaJson from './isla.avatar.json'

export const IslaAvatar = createAvatar(islaJson as typeof islaJson & import('./Avatar').AvatarDefinition)
export type IslaAnimation = keyof typeof islaJson.animations
