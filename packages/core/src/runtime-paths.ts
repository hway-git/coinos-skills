import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const HELIX_REPO_ROOT = process.env.HELIX_REPO_ROOT
  ? resolve(process.env.HELIX_REPO_ROOT)
  : resolve(PACKAGE_ROOT, '..', '..')
