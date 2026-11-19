import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreatorContactForm } from '../src/creator/creator-contact-form';

test('onboarding contact fields use appropriate inputs and restore saved details independently from login email', () => {
  const html = renderToStaticMarkup(
    <CreatorContactForm
      today="2026-11-19"
      action={() => {}}
      details={{
        personalEmail: 'private@example.test',
        phone: '+12025550123',
        dateOfBirth: '1996-02-29',
        addressLine1: 'PO Box 123',
        addressLine2: '',
        city: 'New York',
        region: 'NY',
        postalCode: '10001',
        country: 'United States',
      }}
    />,
  );
  assert.match(html, /type="email"[^>]*|name="personalEmail"/);
  assert.match(html, /value="private@example.test"/);
  assert.match(html, /type="date"/);
  assert.match(html, /max="2026-11-19"/);
  assert.match(html, /value="1996-02-29"/);
  assert.match(html, /value="PO Box 123"/);
  assert.match(html, /receiving gifted items/);
  assert.match(html, /authorized EMG managers/);
});
