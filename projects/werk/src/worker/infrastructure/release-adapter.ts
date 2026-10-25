import type { ReleasePort } from '../application/release-contracts.js';
import { createReleaseBuild, releaseArtifactDirectory } from './release-build.js';
import { createReleaseGitHub } from './release-github.js';

/** The composition root supplies the assigned repository and current policy authorization. */
export function createReleaseAdapter(options: { repository: string; stateDirectory: string; remote?: string; authorize?: (mutation: boolean) => void | Promise<void> }): ReleasePort {
  return { ...createReleaseBuild(options), ...createReleaseGitHub({ cwd: options.repository, authorize: options.authorize,
    artifactDirectory: operation => releaseArtifactDirectory(options.stateDirectory, operation) }) };
}
