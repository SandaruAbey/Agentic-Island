import type { IslandApi } from '@shared/types'

declare global {
  interface Window {
    island: IslandApi
  }
}
export {}

