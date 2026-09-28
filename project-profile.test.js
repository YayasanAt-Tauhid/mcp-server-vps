import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertProjectId,
  assertSystemdServiceName,
  normalizeProjectProfile,
  updateProjectProfile
} from './project-profile.js';

const NOW = '2026-09-25T05:00:00.000Z';

test('project id and service names are strict', () => {
  assert.equal(assertProjectId('project-x'), 'project-x');
  assert.equal(assertSystemdServiceName('project-x.service'), 'project-x.service');
  assert.equal(assertSystemdServiceName('worker@1.service'), 'worker@1.service');
  assert.throws(() => assertProjectId('Project X'), /lowercase slug/);
  assert.throws(() => assertProjectId('../escape'), /lowercase slug/);
  assert.throws(() => assertSystemdServiceName('../bad.service'), /aman/);
  assert.throws(() => assertSystemdServiceName('nginx'), /service name/);
});

test('project profile normalizes portable project metadata', () => {
  const profile = normalizeProjectProfile({
    projectId: 'project-x',
    displayName: 'Project X',
    repoPath: '/home/app/projects/project-x/app',
    handbookPath: '/home/app/projects/project-x/handbook',
    browserHosts: ['project-x.example', '.project-x.example'],
    smokeUrls: ['https://project-x.example/', 'https://app.project-x.example/login'],
    services: ['project-x.service', 'project-x-worker.service'],
    uploadRoots: ['/home/app/projects/project-x/app/public/uploads'],
    imageRoots: ['/home/app/projects/project-x/app/public']
  }, { now: NOW });

  assert.equal(profile.version, 1);
  assert.equal(profile.projectId, 'project-x');
  assert.equal(profile.createdAt, NOW);
  assert.equal(profile.updatedAt, NOW);
  assert.deepEqual(profile.services, ['project-x.service', 'project-x-worker.service']);
  assert.deepEqual(profile.smokeUrls, ['https://project-x.example/', 'https://app.project-x.example/login']);
});

test('project profile rejects broad roots, foreign smoke host and secrets', () => {
  assert.throws(() => normalizeProjectProfile({
    projectId: 'x',
    repoPath: '/srv/x',
    uploadRoots: ['/home']
  }, { now: NOW }), /terlalu luas/);

  assert.throws(() => normalizeProjectProfile({
    projectId: 'x',
    repoPath: '/srv/x',
    browserHosts: ['x.example'],
    smokeUrls: ['https://evil.example/']
  }, { now: NOW }), /browserHosts/);

  assert.throws(() => normalizeProjectProfile({
    projectId: 'x',
    repoPath: '/srv/x',
    displayName: ['pass', 'word=', 'super', 'secret', '123'].join('')
  }, { now: NOW }), /secret/);
});

test('project profile rejects query/credentials and unknown fields', () => {
  assert.throws(() => normalizeProjectProfile({
    projectId: 'x',
    repoPath: '/srv/x',
    browserHosts: ['x.example'],
    smokeUrls: ['https://x.example/?token=abc']
  }, { now: NOW }), /query/);

  assert.throws(() => normalizeProjectProfile({
    projectId: 'x',
    repoPath: '/srv/x',
    browserHosts: ['x.example'],
    smokeUrls: ['https://u:p@x.example/']
  }, { now: NOW }), /credential/);

  assert.throws(() => normalizeProjectProfile({
    projectId: 'x',
    repoPath: '/srv/x',
    surprise: true
  }, { now: NOW }), /field tidak dikenal/);
});

test('project update keeps identity and creation time', () => {
  const existing = normalizeProjectProfile({
    projectId: 'x',
    repoPath: '/srv/x',
    displayName: 'X',
    browserHosts: ['x.example'],
    smokeUrls: ['https://x.example/']
  }, { now: NOW });

  const updated = updateProjectProfile(existing, {
    displayName: 'X Platform',
    services: ['x.service']
  }, { now: '2026-09-25T06:00:00.000Z' });

  assert.equal(updated.projectId, 'x');
  assert.equal(updated.createdAt, NOW);
  assert.equal(updated.updatedAt, '2026-09-25T06:00:00.000Z');
  assert.equal(updated.displayName, 'X Platform');
  assert.deepEqual(updated.services, ['x.service']);

  assert.throws(() => updateProjectProfile(existing, { projectId: 'y' }, { now: NOW }), /tidak boleh diubah/);
  assert.throws(() => updateProjectProfile(existing, { createdAt: NOW }, { now: NOW }), /tidak boleh diubah/);
});

test('backend-only project profile may omit browser settings and broad repo roots are rejected', () => {
  const profile = normalizeProjectProfile({
    projectId: 'backend-only',
    repoPath: '/srv/backend-only'
  }, { now: NOW });
  assert.deepEqual(profile.browserHosts, []);
  assert.deepEqual(profile.smokeUrls, []);

  assert.throws(() => normalizeProjectProfile({
    projectId: 'bad-root',
    repoPath: '/home'
  }, { now: NOW }), /terlalu luas/);
});
