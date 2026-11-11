// Review access (ROADMAP phase 5; owner 2026-11-11): the ACL a parked frame's
// document gets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aclBody, ownerOf } from '../src/access.js';

const CSS = 'https://assets-css.localhost:13443/';

test('the owner is the pod\'s WebID; the readers get Read and nothing else', () => {
  const doc = `${CSS}author/assets/2026/report.html`;
  assert.equal(ownerOf(doc), `${CSS}author/profile/card#me`);
  assert.equal(ownerOf(`${CSS}author/notes/x.html`), null);
  const body = aclBody(doc, { owner: ownerOf(doc), service: `${CSS}lifecycle/profile/card#me`, readers: [`${CSS}reviewer/profile/card#me`] });
  const [full, review] = body.split('<#review>');
  assert.match(full, /acl:agent <https:\/\/assets-css\.localhost:13443\/author\/profile\/card#me>, <https:\/\/assets-css\.localhost:13443\/lifecycle\/profile\/card#me>;/);
  assert.match(full, /acl:mode acl:Read, acl:Write, acl:Control\./);
  assert.match(review, /acl:agent <https:\/\/assets-css\.localhost:13443\/reviewer\/profile\/card#me>;/);
  assert.match(review, /acl:mode acl:Read\.\n/);
  assert.doesNotMatch(review, /Write|Control|Append/);
  assert.equal((body.match(/acl:accessTo/g) || []).length, 2);
  assert.doesNotMatch(body, /acl:default/, 'a document ACL, not a container default');
});
