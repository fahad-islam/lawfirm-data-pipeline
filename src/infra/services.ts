import { DatabaseLive } from '@/db/index.ts'
import { Layer } from 'effect'

export const InfraLayer = Layer.mergeAll(
    DatabaseLive,
)
