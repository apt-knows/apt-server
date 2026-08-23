import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentInstance } from '../domain.js';
import { sha256 } from './compiler.js';
import type { ClawTurnBundle } from './domain.js';
import type { RuntimePrivateArtifacts } from './repository.js';

interface RuntimeMarker {
  runtimeHash: string;
}

export class ClawMaterializer {
  constructor(private readonly hermesHome: string) {}

  private profileDirectory(instance: AgentInstance) {
    if (!/^apt-[a-f0-9]{20}$/.test(instance.hermesProfileName)) throw new Error('Refusing to materialize an invalid Hermes profile name.');
    return join(this.hermesHome, 'profiles', instance.hermesProfileName);
  }

  async readCompletedPrivateArtifacts(instance: AgentInstance): Promise<RuntimePrivateArtifacts | null> {
    const root = this.profileDirectory(instance);
    const marker = await readOptional(join(root, '.apt-claw.json'));
    if (!marker) return null;
    try { JSON.parse(marker) as RuntimeMarker; } catch { return null; }
    const skillsRoot = join(root, 'skills');
    let directories: string[] = [];
    try { directories = await readdir(skillsRoot); } catch { /* fresh profile */ }
    const skills: RuntimePrivateArtifacts['skills'] = [];
    for (const key of directories.filter((entry) => /^private\.[a-z0-9][a-z0-9_.-]{0,116}$/.test(entry)).sort()) {
      const content = await readOptional(join(skillsRoot, key, 'SKILL.md'));
      if (content === null || content.length > 40_000) continue;
      skills.push({ key, title: titleFromSkill(content, key), content, checksum: sha256(content) });
    }
    return {
      soulText: (await readOptional(join(root, 'SOUL.md'))) ?? '',
      hotUserText: (await readOptional(join(root, 'memories', 'USER.md'))) ?? '',
      hotMemoryText: (await readOptional(join(root, 'memories', 'MEMORY.md'))) ?? '',
      skills,
    };
  }

  async materialize(instance: AgentInstance, bundle: ClawTurnBundle, runtimeHash: string) {
    const root = this.profileDirectory(instance);
    await mkdir(join(root, 'memories'), { recursive: true, mode: 0o700 });
    await this.removeNonPrivateLocalSkills(root);
    const currentMarker = await readOptional(join(root, '.apt-claw.json'));
    if (currentMarker) {
      try {
        if ((JSON.parse(currentMarker) as RuntimeMarker).runtimeHash === runtimeHash) return false;
      } catch { /* replace invalid marker */ }
    }
    await atomicWrite(join(root, 'SOUL.md'), bundle.profile.soulText, 0o600);
    await atomicWrite(join(root, 'memories', 'USER.md'), bundle.profile.hotUserText, 0o600);
    await atomicWrite(join(root, 'memories', 'MEMORY.md'), bundle.profile.hotMemoryText, 0o600);
    await this.materializeSharedSkills(root, bundle);
    for (const skill of bundle.privateSkills) {
      await atomicWrite(join(root, 'skills', skill.key, 'SKILL.md'), skill.content, 0o600);
    }
    await atomicWrite(join(root, '.apt-claw.json'), JSON.stringify({ runtimeHash }), 0o600);
    return true;
  }

  private async removeNonPrivateLocalSkills(root: string) {
    const skillsRoot = join(root, 'skills');
    let entries: Dirent[] = [];
    try { entries = await readdir(skillsRoot, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.name.startsWith('private.')) await rm(join(skillsRoot, entry.name), { recursive: true, force: true });
    }
  }

  private async materializeSharedSkills(root: string, bundle: ClawTurnBundle) {
    const destination = join(root, 'apt-shared-skills');
    const staging = `${destination}.next-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    for (const document of bundle.release.documents.filter((item) => item.enabled && item.kind === 'skill')) {
      if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(document.key)) throw new Error('Shared skill key is invalid.');
      const directory = join(staging, document.key);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, 'SKILL.md'), document.content, { encoding: 'utf8', mode: 0o600 });
      await chmod(join(directory, 'SKILL.md'), 0o400);
      await chmod(directory, 0o500);
    }
    await chmod(staging, 0o500);
    const previous = `${destination}.previous-${process.pid}`;
    await rm(previous, { recursive: true, force: true });
    try { await rename(destination, previous); } catch { /* first release */ }
    await rename(staging, destination);
    await rm(previous, { recursive: true, force: true });
  }
}

async function readOptional(path: string) {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

async function atomicWrite(path: string, content: string, mode: number) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.next-${process.pid}`;
  await writeFile(temporary, content, { encoding: 'utf8', mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

function titleFromSkill(content: string, fallback: string) {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return (heading || fallback).slice(0, 200);
}
