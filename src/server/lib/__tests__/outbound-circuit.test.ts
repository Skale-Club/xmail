import { describe, expect, it } from 'vitest'
import { isTransportFailureCode, OUTBOUND_CIRCUIT_TRIP_AFTER, OutboundCircuit } from '../outbound-circuit'

describe('isTransportFailureCode', () => {
    it('recognizes the pre-dialogue connection codes normalizeProviderFailure emits', () => {
        for (const code of ['edns', 'ECONNECTION', 'econnrefused', 'etimedout', 'connection_failed']) {
            expect(isTransportFailureCode(code)).toBe(true)
        }
    })
    it('never counts a server verdict or an unknown outcome as a transport failure', () => {
        for (const code of ['smtp_451', 'smtp_550', 'provider_outcome_unknown', 'eauth', null, undefined, '']) {
            expect(isTransportFailureCode(code)).toBe(false)
        }
    })
})

describe('OutboundCircuit', () => {
    it('opens only after consecutive transport failures', () => {
        const circuit = new OutboundCircuit()
        for (let i = 0; i < OUTBOUND_CIRCUIT_TRIP_AFTER - 1; i++) circuit.record('econnection')
        expect(circuit.open).toBe(false)
        circuit.record('edns')
        expect(circuit.open).toBe(true)
        expect(circuit.consecutiveTransportFailures).toBe(OUTBOUND_CIRCUIT_TRIP_AFTER)
    })

    it('a success or a recipient verdict in between resets the count', () => {
        const circuit = new OutboundCircuit(2)
        circuit.record('econnection')
        circuit.record(null) // sent
        circuit.record('econnection')
        circuit.record('smtp_550') // the recipient's verdict on one message
        circuit.record('econnection')
        expect(circuit.open).toBe(false)
        circuit.record('etimedout')
        expect(circuit.open).toBe(true)
    })
})
