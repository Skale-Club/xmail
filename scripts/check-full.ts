import 'dotenv/config'
import { db } from '../src/db'
import { organizations, organizationUsers, users } from '../src/db/schema'

async function checkFull() {
    console.log('=== Full Database Check ===\n')

    // List all users with full details
    const allUsers = await db.query.users.findMany()
    console.log('=== USERS ===')
    if (allUsers.length === 0) {
        console.log('No users found!')
    } else {
        allUsers.forEach(user => {
            console.log(`ID: ${user.id}`)
            console.log(`Email: ${user.email}`)
            console.log(`Name: ${user.firstName} ${user.lastName}`)
            console.log(`Is Admin: ${user.isAdmin}`)
            console.log(`Created: ${user.createdAt}`)
            console.log('---')
        })
    }

    // List all organizations
    const allOrgs = await db.query.organizations.findMany()
    console.log('\n=== ORGANIZATIONS ===')
    if (allOrgs.length === 0) {
        console.log('No organizations found!')
    } else {
        allOrgs.forEach(org => {
            console.log(`ID: ${org.id}`)
            console.log(`Name: ${org.name}`)
            console.log(`Slug: ${org.slug}`)
            console.log(`Owner ID: ${org.ownerId}`)
            console.log(`Created: ${org.createdAt}`)
            console.log('---')
        })
    }

    // List all organization_users
    const allMemberships = await db.query.organizationUsers.findMany()
    console.log('\n=== ORGANIZATION_USERS ===')
    if (allMemberships.length === 0) {
        console.log('No memberships found!')
    } else {
        allMemberships.forEach(m => {
            console.log(`ID: ${m.id}`)
            console.log(`Org ID: ${m.organizationId}`)
            console.log(`User ID: ${m.userId}`)
            console.log(`Role: ${m.role}`)
            console.log('---')
        })
    }

    // Check for mismatches
    console.log('\n=== ANALYSIS ===')
    for (const org of allOrgs) {
        const owner = allUsers.find(u => u.id === org.ownerId)
        if (!owner) {
            console.log(`ISSUE: Organization "${org.name}" has owner_id ${org.ownerId} but no user with that ID exists!`)
        } else {
            console.log(`OK: Organization "${org.name}" owner is ${owner.email}`)
        }

        const membership = allMemberships.find(m => m.organizationId === org.id)
        if (!membership) {
            console.log(`ISSUE: Organization "${org.name}" has no entry in organization_users!`)
        } else {
            const memberUser = allUsers.find(u => u.id === membership.userId)
            console.log(`OK: Organization "${org.name}" has member ${memberUser?.email || 'unknown'} with role ${membership.role}`)
        }
    }

    process.exit(0)
}

checkFull().catch(console.error)
