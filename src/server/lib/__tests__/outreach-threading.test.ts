import { describe, expect, it } from 'vitest'
import {
    MAX_REFERENCE_IDS,
    buildReferencesChain,
    planStepThreading,
    replySubjectFor,
    type PreviousSentEmail,
} from '../outreach-threading'

const STEP_1: PreviousSentEmail = {
    messageId: 'xmail-aaa@tryskaleclub.com',
    messageReferences: null,
    subject: 'Quick question about {{companyName}}',
}

describe('replySubjectFor', () => {
    it('prefixes the previous subject with Re:', () => {
        expect(replySubjectFor('Quick question')).toBe('Re: Quick question')
    })

    it('does not double an existing Re:, in any case or spacing', () => {
        expect(replySubjectFor('Re: Quick question')).toBe('Re: Quick question')
        expect(replySubjectFor('RE:Quick question')).toBe('Re: Quick question')
        expect(replySubjectFor('re: RE: Quick question')).toBe('Re: Quick question')
    })

    it('keeps a Re inside the subject untouched', () => {
        expect(replySubjectFor('Regarding the shop')).toBe('Re: Regarding the shop')
    })

    it('returns blank for a blank previous subject, so the caller can refuse to send it', () => {
        expect(replySubjectFor('  ')).toBe('')
        expect(replySubjectFor('Re:')).toBe('')
    })
})

describe('buildReferencesChain', () => {
    it('is just the previous id when the previous email started the thread', () => {
        expect(buildReferencesChain(null, 'a@x.test')).toBe('<a@x.test>')
    })

    it('appends the previous id to its chain, oldest first, without duplicates', () => {
        expect(buildReferencesChain('<a@x.test>', 'b@x.test')).toBe('<a@x.test> <b@x.test>')
        expect(buildReferencesChain('<a@x.test> <b@x.test>', '<b@x.test>')).toBe('<a@x.test> <b@x.test>')
    })

    it('keeps only the last MAX_REFERENCE_IDS ids', () => {
        const long = Array.from({ length: 14 }, (_, i) => `<m${i}@x.test>`).join(' ')
        const chain = buildReferencesChain(long, 'last@x.test').split(' ')

        expect(chain).toHaveLength(MAX_REFERENCE_IDS)
        expect(chain.at(-1)).toBe('<last@x.test>')
        expect(chain[0]).toBe('<m5@x.test>')
    })
})

describe('planStepThreading', () => {
    it('adds no threading and keeps the subject for a first send (nothing to reply to)', () => {
        expect(planStepThreading({ subject: 'Hello', previous: null }))
            .toEqual({ subject: 'Hello', inReplyTo: null, references: null })
    })

    it('threads step 2 under step 1', () => {
        const plan = planStepThreading({ subject: 'Following up', previous: STEP_1 })

        expect(plan.inReplyTo).toBe('<xmail-aaa@tryskaleclub.com>')
        expect(plan.references).toBe('<xmail-aaa@tryskaleclub.com>')
    })

    it('threads step 3 under step 2 and carries the whole chain', () => {
        const step2Sent: PreviousSentEmail = {
            messageId: 'xmail-bbb@tryskaleclub.com',
            // What step 2 froze into outreach_emails.message_references.
            messageReferences: planStepThreading({ subject: 'x', previous: STEP_1 }).references,
            subject: 'Re: Quick question about {{companyName}}',
        }
        const plan = planStepThreading({ subject: '', previous: step2Sent })

        expect(plan.inReplyTo).toBe('<xmail-bbb@tryskaleclub.com>')
        expect(plan.references).toBe('<xmail-aaa@tryskaleclub.com> <xmail-bbb@tryskaleclub.com>')
        // Not "Re: Re: ...": step 2's stored subject already had the prefix.
        expect(plan.subject).toBe('Re: Quick question about {{companyName}}')
    })

    it('turns a blank subject into Re: <previous subject>', () => {
        expect(planStepThreading({ subject: '', previous: STEP_1 }).subject)
            .toBe('Re: Quick question about {{companyName}}')
        expect(planStepThreading({ subject: '   ', previous: STEP_1 }).subject)
            .toBe('Re: Quick question about {{companyName}}')
    })

    it('keeps a subject the step spells out, exactly as written, and still threads', () => {
        const plan = planStepThreading({ subject: 'One more thing, {{firstName}}', previous: STEP_1 })

        expect(plan.subject).toBe('One more thing, {{firstName}}')
        expect(plan.inReplyTo).toBe('<xmail-aaa@tryskaleclub.com>')
    })

    it('leaves a blank subject blank when there is nothing to reply to, for the caller to refuse', () => {
        expect(planStepThreading({ subject: '', previous: null }).subject).toBe('')
    })
})
