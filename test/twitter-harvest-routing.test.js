import test from 'node:test';
import assert from 'node:assert/strict';
import { twitterHarvestKind } from '../dist/twitter/harvest.js';

test('structured Twitter harvest routing follows URL shape', () => {
  assert.equal(
    twitterHarvestKind('https://x.com/loubohan/status/2082143914924851449'),
    'tweet',
  );
  assert.equal(
    twitterHarvestKind('https://x.com/i/article/2082143914924851449'),
    'article',
  );
  assert.equal(
    twitterHarvestKind('https://x.com/loubohan/article/2082143914924851449'),
    'article',
  );
  assert.equal(twitterHarvestKind('https://x.com/loubohan'), null);
  assert.equal(twitterHarvestKind('https://mobile.twitter.com/alice/status/123'), 'tweet');
  assert.equal(twitterHarvestKind('https://m.twitter.com/alice/status/123'), 'tweet');
  assert.equal(twitterHarvestKind('https://mobile.x.com/alice/status/123'), 'tweet');
  assert.equal(twitterHarvestKind('https://example.com/alice/status/123'), null);
});
