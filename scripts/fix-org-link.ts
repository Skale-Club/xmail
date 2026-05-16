import 'dotenv/config'
import { db } from '../src/db'
import { organizations, organizationUsers, users } from '../src/db/schema'
import { eq } from 'drizzle-orm'

async function fixOrganizationLink() {
    console.log('=== Fix Organization Link ===\n')

    // Get the real logged-in user (the one that was auto-created by the system)
    const allUsers = await db.query.users.findMany()

    if (allUsers.length === 0) {
        console.log('No users found in the database.')
        console.log('Please login to the system first, then run this script again.')
        process.exit(1)
    }

    console.log('Users in database:')
    allUsers.forEach(user => {
        console.log(` - ID: ${user.id}`)
        console.log(` Email: ${user.email}`)
        console.log('')
    })

    // Get the organization
    const allOrgs = await db.query.organizations.findMany()

    if (allOrgs.length === 0) {
        console.log('No organizations found in the database.')
        process.exit(1)
    }

    console.log('Organizations in database:')
    allOrgs.forEach(org => {
        console.log(` - ID: ${org.id}`)
        console.log(` Name: ${org.name}`)
        console.log(` Owner ID: ${org.ownerId}`)
        console.log('')
    })

    // For each organization, update the owner and create organization_users entry
    for (const org of allOrgs) {
        // Find the user that should own this organization (by matching email or use first user)
        const realUser = allUsers.find(u => u.id !== org.ownerId) || allUsers[0]

        if (realUser && realUser.id !== org.ownerId) {
            console.log(`Updating organization "${org.name}"...`)
            console.log(` Old owner_id: ${org.ownerId}`)
            console.log(` New owner_id: ${realUser.id}`)

            // Update organization owner
            await db.update(organizations)
                .set({ ownerId: realUser.id })
                .where(eq(organizations.id, org.id))

            // Delete old organization_users entry if exists
            await db.delete(organizationUsers)
                .where(eq(organizationUsers.organizationId, org.id))

            // Create new organization_users entry
            await db.insert(organizationUsers).values({
                organizationId: org.id,
                userId: realUser.id,
                role: 'admin',
            })

            console.log(' Done!\n')
        } else if (realUser && realUser.id === org.ownerId) {
            // Check if organization_users entry exists
            const existingMembership = await db.query.organizationUsers.findFirst({
                where: eq(organizationUsers.organizationId, org.id),
            })

            if (!existingMembership) {
                console.log(`Creating organization_users entry for "${org.name}"...`)
                await db.insert(organizationUsers).values({
                    organizationId: org.id,
                    userId: realUser.id,
                    role: 'admin',
                })
                console.log(' Done!\n')
            } else {
                console.log(`Organization "${org.name}" is already correctly linked.`)
            }
        }
    }

    console.log('\n=== Verification ===')

    // Verify the changes
    const updatedMemberships = await db.query.organizationUsers.findMany()
    console.log('Organization-User relationships after fix:')
    updatedMemberships.forEach(m => {
        console.log(` - Org ID: ${m.organizationId}`)
        console.log(` User ID: ${m.userId}`)
        console.log(` Role: ${m.role}`)
        console.log('')
    })

    process.exit(0)
}

fixOrganizationLink().catch(console.error)
