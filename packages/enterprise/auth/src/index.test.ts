import { describe, expect, it } from 'vitest'
import plugin from './index.js'
describe('enterprise auth', () => { it('exports a plugin entry', () => expect(plugin).toBeTypeOf('function')) })
