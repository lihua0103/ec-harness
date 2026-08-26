import { describe, expect, it } from 'vitest'
import plugin from './index.js'
describe('ui settings', () => { it('exports a plugin entry', () => expect(plugin).toBeTypeOf('function')) })
