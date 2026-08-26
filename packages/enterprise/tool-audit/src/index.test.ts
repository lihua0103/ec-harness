import { describe, expect, it } from 'vitest'
import plugin from './index.js'
describe('tool audit', () => { it('exports a plugin entry', () => expect(plugin).toBeTypeOf('function')) })
