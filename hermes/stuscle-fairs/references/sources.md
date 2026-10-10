# Craft fair radar: source notes (checked 2026-10-09)

All "kept" sources were fetched with Python `requests` and a Chrome user agent (the same way the radar will fetch them), the raw HTML was saved, and a fair name was found by substring search in the raw bytes. `curl` was not used for the page checks (only for the Census files). Page sizes are in `sources.json`.

## Kept (18 URLs, 7 site families)

| Family | URLs | Why |
|---|---|---|
| Meet Me at the Fair | MetroWest region, Greater Boston region, Holiday Markets (MA), Craft Fairs (MA, 2 pages) | Server-rendered, clean region pages that match the radius. Best signal-to-noise. Show ticket price, not booth fee. |
| FestivalNet | MA craft shows, pages 1-3 | Date-sorted, reaches September 2027. Lists small Rotary/church/school fairs, the number of exhibitors and Juried yes/no (competition signal). |
| FairsAndFestivals.net | `/states/MA` | All 149 MA events on one page, through 2027, with "Types of Vendor". |
| Castleberry Fairs | schedule, booth pricing, show availability | Big juried promoter. Pricing page is the fee benchmark. Availability page shows category limits (competition signal). |
| New England Open Markets | home, holiday applications | Maker-market promoter with published application deadlines (Nov 10 for the December markets). |
| Patch town calendars | Natick, Wellesley, Marlborough | Short-horizon (about 2 weeks) local calendars. Caught the Needham High School Artisan Craft Fair and a Boylston craft fair. Low yield, kept as a late-announcement net. |
| Sherborn Holiday Market | 1858 Town House event page | Single-event watch page for a tier A town. No vendor info yet. |

## Rejected, and why

- **TheCraftMap** (`thecraftmap.com/fairs/massachusetts` and town pages): the most useful MA directory (booth fee, deadline, juried flag, per town), but plain HTTP GET returns HTTP 429 "Vercel Security Checkpoint" (bot challenge). Cannot be used by the radar. Its facts only reached me through search-result summaries, so treat any figure attributed to it below as secondhand. Use search queries that surface its fair pages, or fetch with a real browser service if the owner accepts the cost.
- **Meet Me at the Fair "Craft Shows" page and the all-MA page**: "craft-shows" is empty; the all-MA page shows only the first 30 events by date, which the region/category pages cover better.
- **Patch calendars for Framingham, Wayland, Sudbury, Needham, Westborough, Holliston-Hopkinton, Weston**: static HTML and reachable, but zero fair-related lines on the check date (Framingham, Wayland, Sudbury, Holliston-Hopkinton, Weston) or only unrelated "artisan" business names (Needham, Westborough). The Dover-Sherborn slug returns 404. Can be added later; they are cheap.
- **Macaroni Kid Framingham-Natick-Sudbury**: static, but only about 3,000 characters of text and no fairs.
- **Acton Exchange calendar, Swellesley Report events, libraries.state.ma.us events**: static and large, but no craft fair on the check date (Acton: only generic "vendors" in festival blurbs). Low yield.
- **The Boston Calendar**: HTTP 500 with a Cloudflare-style error to scripted requests.
- **Grindkit event pages**: static, but they are stubs that copy Meet Me at the Fair ("Boston Metro Holiday Craft Fairs", date TBA).
- **Eventeny vendor pages** (`eventeny.com/events/vendor/?id=...`): static and include booth prices and deadlines, but they are single events. Eventeny's search is JavaScript. The Topsfield one (id 45144) is also about 35 miles away and sold out ("All Categories are Full" on Castleberry's availability page).
- **Paradise City Arts Festival (Marlborough, Nov 20-22, juried)**: static page but no fees, and it is a high-end fine craft show. Left out.
- **Unreachable from here**: mikeandpatscraftshows.com, newenglandhandmademarket.com, sherbornholidaymarket.org (connection errors). Mike & Pat's own schedule is only visible through FestivalNet's promoter calendar (Leominster Arts and Craft Show, Nov 1, 2026).
- **Census API** (`api.census.gov`): now requires an API key ("Missing Key"). Income data came from the Census Reporter API instead (see below).
- **Excluded by the brief**: Facebook, Instagram, Eventbrite search, anything with login.

## What I observed about cost and timing

- **Booth fees in this area are mostly far above US$ 75.** Castleberry 2026 booth prices: 10x6 about $325-350, 10x10 $425, up to $675 for 20x10 (Marlborough, Wilmington, Concord NH). The Topsfield New England Craft & Specialty Food Fair (Eventeny page, Nov 13-15) starts at $525 for a 10x6 booth. A third-party listing (via search summary, not fetched by me) puts the Sherborn Holiday Market at $125-$185, juried, application deadline Oct 30, 2026.
- **US$ 75 or less shows up at small church, school, club and historical-society fairs**, seen only through search summaries (secondhand, unverified by me): Lowell St. Michael Holly Fair about $40 a table (Dec 5), a Wakefield VFW auxiliary fair $45 a table, Townsend Historical Society $75 before Aug 1 and $80 after, a 2015 Westborough church post "begins at $40". These are outside the main directories, which is why the search queries focus on church/PTO/Lions/Rotary fairs.
- **Directories do not show booth fees** (FestivalNet and FairsAndFestivals gate them behind member accounts; Meet Me at the Fair shows shopper ticket prices). Only Castleberry's pricing page has fees. Fee extraction will usually require the LLM to follow the organizer's link or a follow-up fetch.
- **Application windows for the fall/holiday 2026 shows**: roughly 5-8 weeks before the event (NEOM deadline Nov 10 for Dec 5-20 markets; Sherborn Oct 30 for Dec 12; Topsfield Nov 9 for Nov 13). Several highest-value MetroWest fairs have already closed or are about to: the Needham High School Artisan Craft Fair (Oct 24) took submissions in March in a previous year, and the East Coast Garden Center Holiday Craft Fair window was July 1-31 (search summaries). Practical lesson: for 2027 expect big or juried fairs to open applications 4-6 months ahead (Grindkit's note for Boston-area church bazaars; unverified), so spring 2027 shows should be watched from about November 2026 and summer/fall 2027 shows from about spring 2027. I did not observe any 2027 application window directly: Castleberry had not posted its 2027 schedule on the check date.
- **Known 2027 dates already in the static HTML**: FestivalNet page 3 lists shows on Feb 20, Apr 22-25, May 22-23, Jun 6-13, Jun 12-13, Jul 17-18, Aug 7-8, Aug 21-22 and Sep 11-12, 2027; FairsAndFestivals lists MA events from March 2027.
- **Nearby events seen in the sources (2026)**: Framingham Rotary Holiday Craft Fair (Dec 12, Keefe Tech, about 118-120 exhibitors, not juried, admission $5), Wellesley Marketplace (Nov 21, Wellesley High School, over 200 booths, run by the Wellesley Hills Junior Women's Club), Framingham Fall Fair (Oct 24, Plymouth Church), Needham High School Artisan Craft Fair (Oct 24), Sherborn Holiday Market (Dec 12), Franklin Rotary Tri-County Craft Fair (Nov 14), Umbrella Winter Market (Concord, Dec 4-6), NEOM Cohasset Holiday Market (Dec 12). I did not find booth fees for any of these except Sherborn (secondhand).

## Things the radar must handle

- Several pages change every day for reasons unrelated to fairs: Patch (date in title and headers), Meet Me at the Fair ("In 7 days", "Happening now"). Normalize these out before hashing or the LLM will run daily.
- The Meet Me at the Fair and FestivalNet pages are 200-450 KB of HTML each; extract the listing block before sending to the LLM.
- Directory pages are statewide. Match each event's town against `towns.json` and drop towns outside the list (Cape Cod, Berkshires and Pioneer Valley items are common).
- Dates from the directories are producer-entered. Meet Me at the Fair flags some as "Tentative"; FestivalNet shows an "Updated" date per listing.

## Towns (towns.json)

- Source: Census Reporter API serving ACS 2024 5-year (2020-2024) table B19013, county-subdivision level, fetched 2026-10-09; centroids from the Census 2024 Gazetteer. The official Census API needs a key, so I used Census Reporter, which republishes the same table.
- 105 towns with straight-line distance up to 24 miles from Framingham (estimated driving miles = straight-line x 1.3, rounded; not routed, so treat as plus or minus 20%). Towns with an estimate above 30 are borderline for the 30-mile radius. Tiers: A 26, B 44, C 35.
- Five values are the ACS cap (250,001, flagged `top_coded`): Sherborn, Weston, Wellesley, Dover and Carlisle. Their true median is at least $250,000, and the margin of error is not published for them.
- Margins of error are large for small towns (for example Lincoln $175,117 with a margin of error of $43,879, near the A/B border). Tier boundaries are not sharp for those towns.
- Framingham city itself is tier C ($107,419), as are Marlborough, Waltham and Boston (whole-city medians). Neighbourhood income varies, but only town-level data was used.

## Uncertain or unverified

- Every fee, deadline and date marked "secondhand" above came from search-result summaries, not from a page I fetched.
- The "Craft Map" claims (average booth fee about $128 in MA, $195 for Needham) are secondhand and should not drive decisions.
- I did not verify any organizer application page. None of the sources above exposes a vendor application link in a way an automated script can follow reliably; the LLM should extract the organizer name and link from each listing and a second step should fetch it.

## Removed after review (2026-10-09)

The three Castleberry Fairs pages (`castleberry-fairs`, `castleberry-booth-pricing`,
`castleberry-show-availability`) answer HTTP 403 to scripted requests, both from a home
connection and from the Hetzner server that runs the radar. They were dropped from
`sources.json`. Castleberry booths run US$ 325 to 675, far above the US$ 75 target, so the
loss is mainly the fee benchmark, which stays recorded above.
