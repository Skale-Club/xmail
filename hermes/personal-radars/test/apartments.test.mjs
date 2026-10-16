import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apartmentIdentityKey,
  assertApartmentMatchesFilters,
  normalizeApartment,
} from '../src/apartments.mjs'

const requiredHousingFilters = {
  studiosAccepted: false,
  minimumBedrooms: 1,
  maximumBedrooms: 2,
  laundryInUnitRequired: true,
  dishwasherRequired: true,
  parking: {
    minimumVehicleSpaces: 2,
    secondSpaceMayBePaid: true,
    streetParkingAccepted: false,
    offSiteParkingAccepted: false,
    maximumWalkDistanceMeters: 100,
    availabilityMustBeConfirmed: true,
  },
}

test('rejects an apartment without confirmed in-unit laundry or dishwasher', () => {
  assert.throws(
    () => assertApartmentMatchesFilters({
      bedrooms: 1,
      laundryInUnit: false,
      dishwasher: true,
    }, requiredHousingFilters),
    /laundryInUnit must be confirmed/,
  )
})

test('requires two confirmed on-site parking spaces while allowing a paid second space', () => {
  const base = {
    bedrooms: 1,
    laundryInUnit: true,
    dishwasher: true,
    parkingSpacesIncluded: 1,
    parkingArrangement: 'on_site',
    parkingWalkMeters: 50,
    parkingAvailabilityConfirmed: true,
  }

  assert.throws(
    () => assertApartmentMatchesFilters({ ...base, additionalPaidParkingSpaces: 0 }, requiredHousingFilters),
    /two usable parking spaces must be confirmed/,
  )
  assert.equal(
    assertApartmentMatchesFilters({ ...base, additionalPaidParkingSpaces: 1 }, requiredHousingFilters),
    true,
  )
})

test('rejects unconfirmed, street, off-site, or distant parking', () => {
  const base = {
    bedrooms: 1,
    laundryInUnit: true,
    dishwasher: true,
    parkingSpacesIncluded: 2,
    additionalPaidParkingSpaces: 0,
    parkingArrangement: 'on_site',
    parkingWalkMeters: 50,
    parkingAvailabilityConfirmed: true,
  }

  assert.throws(
    () => assertApartmentMatchesFilters({ ...base, parkingAvailabilityConfirmed: false }, requiredHousingFilters),
    /parking availability must be confirmed/,
  )
  assert.throws(
    () => assertApartmentMatchesFilters({ ...base, parkingArrangement: 'street' }, requiredHousingFilters),
    /street parking is not accepted/,
  )
  assert.throws(
    () => assertApartmentMatchesFilters({ ...base, parkingArrangement: 'off_site' }, requiredHousingFilters),
    /off-site parking is not accepted/,
  )
  assert.throws(
    () => assertApartmentMatchesFilters({ ...base, parkingWalkMeters: 500 }, requiredHousingFilters),
    /parking is too far from the residence/,
  )
})

test('accepts one or two bedrooms and rejects studios or three-bedroom units', () => {
  const eligible = {
    laundryInUnit: true,
    dishwasher: true,
    parkingSpacesIncluded: 2,
    additionalPaidParkingSpaces: 0,
    parkingArrangement: 'on_site',
    parkingWalkMeters: 50,
    parkingAvailabilityConfirmed: true,
  }

  assert.throws(
    () => assertApartmentMatchesFilters({ ...eligible, bedrooms: 0 }, requiredHousingFilters),
    /at least 1 bedroom is required/,
  )
  assert.equal(assertApartmentMatchesFilters({ ...eligible, bedrooms: 1 }, requiredHousingFilters), true)
  assert.equal(assertApartmentMatchesFilters({ ...eligible, bedrooms: 2 }, requiredHousingFilters), true)
  assert.throws(
    () => assertApartmentMatchesFilters({ ...eligible, bedrooms: 3 }, requiredHousingFilters),
    /at most 2 bedrooms are eligible/,
  )
})

test('calculates known monthly apartment cost without inventing unknown utilities', () => {
  const apartment = normalizeApartment({
    source: 'zillow-email',
    canonicalUrl: 'https://example.test/listing/123',
    address: '100 Main St, Orlando, FL 32801',
    unit: '4B',
    bedrooms: 2,
    bathrooms: 1,
    baseRent: 1_850,
    mandatoryMonthlyFees: 95,
    parkingMonthly: 50,
    petMonthly: 25,
    estimatedUtilities: null,
  })

  assert.equal(apartment.totalMonthlyKnown, 2_020)
  assert.equal(apartment.estimatedUtilities, null)
  assert.equal(apartment.monthlyTotalCompleteness, 'utilities_unknown')
})

test('spreads a free-month promotion across the complete lease term', () => {
  const apartment = normalizeApartment({
    source: 'property-manager-email',
    canonicalUrl: 'https://example.test/listing/456',
    address: '200 Lake Ave, Kissimmee, FL 34741',
    baseRent: 2_400,
    mandatoryMonthlyFees: 100,
    estimatedUtilities: 180,
    leaseMonths: 12,
    promotion: { freeMonths: 1 },
  })

  assert.equal(apartment.effectiveBaseRent, 2_200)
  assert.equal(apartment.totalMonthlyKnown, 2_300)
  assert.equal(apartment.estimatedMonthlyWithUtilities, 2_480)
})

test('deduplicates the same apartment address and unit across sources', () => {
  const zillowKey = apartmentIdentityKey({
    address: '100 Main Street, Orlando, FL 32801',
    unit: 'Apt. 4-B',
  })
  const directKey = apartmentIdentityKey({
    address: '100 main st., Orlando FL 32801',
    unit: '#4B',
  })

  assert.equal(zillowKey, directKey)
})

test('rejects negative apartment costs instead of corrupting comparisons', () => {
  assert.throws(
    () => normalizeApartment({ address: '100 Main St', baseRent: -1 }),
    /baseRent must be a non-negative number/,
  )
})

test('does not merge different floor plans when the unit number is unknown', () => {
  const oneBedroom = apartmentIdentityKey({
    address: '300 Lake Road, Orlando, FL 32801',
    unit: null,
    floorPlan: 'The Palm',
    bedrooms: 1,
    bathrooms: 1,
  })
  const twoBedroom = apartmentIdentityKey({
    address: '300 Lake Rd., Orlando FL 32801',
    unit: null,
    floorPlan: 'The Cypress',
    bedrooms: 2,
    bathrooms: 2,
  })

  assert.notEqual(oneBedroom, twoBedroom)
})

test('flags unknown mandatory fees instead of treating the advertised rent as complete', () => {
  const apartment = normalizeApartment({
    address: '400 Pine St, Orlando, FL 32801',
    baseRent: 1_850,
    mandatoryMonthlyFees: null,
    estimatedUtilities: 150,
  })

  assert.equal(apartment.totalMonthlyKnown, 1_850)
  assert.equal(apartment.monthlyTotalCompleteness, 'mandatory_fees_unknown')
})
