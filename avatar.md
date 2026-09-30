# React avatar usage guide

Install the package, create your component and choose the right control level.

## Installation

Add the React package and its dependencies.

```bash
npm install @bible-strong/avatar-react react react-dom
```

The packages are still private. This command will work after publication; use the workspace or tarballs for local testing.

## Recommended API: create a concrete avatar

createAvatar validates the JSON and returns a dedicated component with typed animation keys.

```tsx
import { createAvatar } from '@bible-strong/avatar-react'
import '@bible-strong/avatar-react/styles.css'
import avatarJson from './avatar.avatar.json'

const StrobiAvatar = createAvatar(avatarJson)

export function Strobi() {
  return <StrobiAvatar defaultAnimation="sleeping" />
}
```

## Avatar props

Complete reference: type, default value, behavior and constraints for every prop.

### Target and playback

- `definition` — `AvatarDefinition`: Required. Validated AvatarDefinition object containing the expressions and animations to display.
- `animation` — `AnimationKey | undefined`: Optional. Controls a timeline by key. Each step chooses the displayed expression. Mutually exclusive with expression; a controlled target takes priority over default values.
- `expression` — `ExpressionKey | undefined`: Optional. Directly controls an expression by key. Mutually exclusive with animation; a controlled target takes priority over default values.
- `defaultAnimation` — `AnimationKey | undefined`: Optional. Defines the initial timeline in uncontrolled mode. Read on mount; autoplay is enabled by default. Mutually exclusive with defaultExpression.
- `defaultExpression` — `ExpressionKey | undefined`: Optional. Defines the initial expression in uncontrolled mode. Read on mount without starting a timeline. Mutually exclusive with defaultAnimation.
- `autoplay` — `boolean | undefined`: Optional, defaults to true. Automatically starts defaultAnimation; without defaultAnimation, it has no effect.
- `ref` — `Ref<AvatarController> | undefined`: Optional. Provides access to the imperative AvatarController API.

### Presentation

- `size` — `number | string | undefined`: Optional, defaults to 240. Number or CSS value used for the container width and height.
- `className` — `string | undefined`: Optional. CSS class added to the outer container.
- `style` — `CSSProperties | undefined`: Optional. Inline styles for the outer container; width and height come from size.
- `ariaLabel` — `string | undefined`: Optional, defaults to “Procedural avatar”. Accessible name announced to screen readers.

### Playback callbacks

- `onAnimationEnd` — `(animation: AnimationKey) => void`: Optional. Receives the key of a once animation when it completes naturally.
- `onExpressionChange` — `(expression: ExpressionKey) => void`: Optional. Receives the expression key whenever the displayed semantic expression changes.
- `onError` — `(error: AvatarRuntimeError) => void`: Optional. Receives a typed error when an animation, expression or default prop references an unknown key.

## Generic Avatar

Use Avatar directly when the definition is loaded at runtime or changes between multiple avatars.

```tsx
import { Avatar } from '@bible-strong/avatar-react'
import type { AvatarDefinition, ExpressionKey } from '@bible-strong/avatar-core'
import '@bible-strong/avatar-react/styles.css'

export function DynamicAvatar({
  definition,
  expression,
}: {
  definition: AvatarDefinition
  expression: ExpressionKey
}) {
  return (
    <Avatar
      definition={definition}
      expression={expression}
      onError={error => console.error(error)}
    />
  )
}
```

## Imperative API

The ref exposes playback commands and the avatar’s current state.

Target commands are available in uncontrolled mode; otherwise use props.

- `play(animation)` — `(animation: AnimationKey) => AvatarCommandResult`: Starts or resumes an animation and returns a typed result.
- `pause()` — `() => void`: Pauses the timeline at its exact position.
- `stop()` — `() => void`: In uncontrolled mode, stops playback and returns to neutral. In controlled mode, props remain the source of truth.
- `setExpression(expression)` — `(expression: ExpressionKey) => AvatarCommandResult`: Directly displays an expression.
- `getState()` — `() => AvatarPlaybackState`: Returns the active animation, expression and status.

```tsx
import { createAvatar, type AvatarController } from '@bible-strong/avatar-react'
import { useRef } from 'react'
import avatarJson from './avatar.avatar.json'

const StrobiAvatar = createAvatar(avatarJson)

export function Controls() {
  const avatar = useRef<AvatarController>(null)

  return <>
    <StrobiAvatar ref={avatar} defaultAnimation="sleeping" />
    <button onClick={() => avatar.current?.play('sleeping')}>Play animation</button>
    <button onClick={() => avatar.current?.pause()}>Pause</button>
    <button onClick={() => avatar.current?.setExpression('neutral')}>Set expression</button>
    <button onClick={() => avatar.current?.stop()}>Stop</button>
    <button onClick={() => console.log(avatar.current?.getState())}>Read state</button>
  </>
}
```