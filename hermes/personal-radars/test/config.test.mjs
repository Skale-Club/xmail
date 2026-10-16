import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function readConfig(name) {
  return JSON.parse(readFileSync(new URL(`../config/${name}.example.json`, import.meta.url), 'utf8'))
}

test('apartment discovery compares Greater Orlando with Framingham and MetroWest without a hard rent cutoff', () => {
  const config = readConfig('apartments')

  assert.equal(config.enabled, true)
  assert.deepEqual(Object.keys(config.marketGroups).sort(), ['florida', 'massachusetts'])
  assert.equal(config.filters.targetAdvertisedBaseRent, 1500)
  assert.equal(config.filters.maximumAdvertisedBaseRent, null)
  assert.equal(config.comparison.enabled, true)
})

test('job discovery covers Orange County tourism roles and compares Florida with MetroWest', () => {
  const config = readConfig('jobs')

  assert.deepEqual(Object.keys(config.marketGroups).sort(), ['florida', 'massachusetts'])
  assert.ok(config.criteria.allowedLocations.includes('Orange County, FL'))
  assert.ok(config.criteria.allowedLocations.includes('Framingham, MA'))
  assert.ok(config.criteria.titleKeywords.includes('guest services'))
  assert.ok(config.criteria.titleKeywords.includes('reservations agent'))
  assert.equal(config.comparison.enabled, true)
})

test('apartment eligibility requires practical in-unit amenities, one or two bedrooms, and two usable parking spaces', () => {
  const config = readConfig('apartments')
  const filters = config.filters

  assert.equal(filters.laundryInUnitRequired, true)
  assert.equal(filters.dishwasherRequired, true)
  assert.equal(filters.studiosAccepted, false)
  assert.equal(filters.minimumBedrooms, 1)
  assert.equal(filters.preferredBedrooms, 1)
  assert.equal(filters.maximumBedrooms, 2)
  assert.equal(filters.parking.minimumVehicleSpaces, 2)
  assert.equal(filters.parking.secondSpaceMayBePaid, true)
  assert.equal(filters.parking.streetParkingAccepted, false)
  assert.equal(filters.parking.availabilityMustBeConfirmed, true)
  assert.equal(filters.comparisonAllowsUnknownAmenities, false)
})
