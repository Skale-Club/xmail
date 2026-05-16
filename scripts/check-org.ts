import 'dotenv/config'
import { db } from '../src/db'
import { organizations, organizationUsers, users } from '../src/db/schema'

async function checkOrganizations() {
    console.log('=== Checking organizations ===\n')

    // List all organizations
    const allOrgs = await db.query.organizations.findMany()
    console.log('Organizations in database:')
    allOrgs.forEach(org => {
        console.log(` - ID: ${org.id}`)
        console.log(` Name: ${org.name}`)
        console.log(` Slug: ${org.slug}`)
        console.log(` Owner ID: ${org.ownerId}`)
        console.log('')
    })

    // List all users
    const allUsers = await db.query.users.findMany()
    console.log('Users in database:')
    allUsers.forEach(user => {
        console.log(` - ID: ${user.id}`)
        console.log(` Email: ${user.email}`)
        console.log('')
    })

    // List all organization_users relationships
    const allMemberships = await db.query.organizationUsers.findMany()
    console.log('Organization-User relationships (organization_users):')
    if (allMemberships.length === 0) {
        console.log(' ** No relationships found! **')
        console.log(' This is likely why organizations are not showing up.')
        console.log(' You need to create entries in organization_users table.')
    } else {
        allMemberships.forEach(m => {
            console.log(` - Org ID: ${m.organizationId}`)
            console.log(` User ID: ${m.userId}`)
            console.log(` Role: ${m.role}`)
            console.log('')
        })
    }

    process.exit(0)
}

checkOrganizations().catch(console.error)
