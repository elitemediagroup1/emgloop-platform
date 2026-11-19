import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCreatorContactDetails,
  type CreatorContactDetailsInput,
} from '../src/creator/creator-contact-details';

const details: CreatorContactDetailsInput = {
  personalEmail: 'creator@example.test',
  phone: '+1 (202) 555-0123',
  dateOfBirth: '1996-02-29',
  addressLine1: 'PO Box 123',
  addressLine2: '',
  city: 'New York',
  region: 'NY',
  postalCode: '10001',
  country: 'United States',
};
test('contact validation preserves a date-only birthday and accepts a preferred mailing address', () => {
  assert.equal(validateCreatorContactDetails(details, '2026-11-19'), null);
  assert.equal(
    validateCreatorContactDetails({
      ...details,
      region: '',
      phone: '+44 20 7946 0123',
      postalCode: 'SW1A 1AA',
      country: 'United Kingdom',
    }),
    null,
  );
});
test('contact validation rejects impossible/future dates and invalid personal contact fields', () => {
  for (const dateOfBirth of [
    '1997-02-29',
    '2026-02-30',
    '2027-01-01',
    '',
    '1996-2-29',
    '0000-01-01',
  ]) {
    assert.ok(validateCreatorContactDetails({ ...details, dateOfBirth }, '2026-11-19'));
  }
  for (const patch of [
    { personalEmail: 'not-an-email' },
    { phone: '123' },
    { phone: 'call me tomorrow' },
    { addressLine1: '' },
    { city: '' },
    { postalCode: '' },
    { country: '' },
    { addressLine2: 'x'.repeat(201) },
  ]) {
    assert.ok(validateCreatorContactDetails({ ...details, ...patch }));
  }
});
