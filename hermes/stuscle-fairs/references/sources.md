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
- Core zone: 104 towns (the original 105 minus Quincy, which moved to the coastal zone) with straight-line distance up to 24 miles from Framingham (estimated driving miles = straight-line x 1.3, rounded; not routed, so treat as plus or minus 20%). Towns with an estimate above 30 are borderline for the 30-mile radius. Tiers: A 26, B 44, C 35.
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

## Coastal zone (added 2026-10-10)

The owner wants North Shore and South Shore beach towns even though most are 35 to 66 driving miles from Framingham. They live in
`towns.json` with `zone: "coast"` and `region: "north_shore"` or `"south_shore"`, get no distance penalty and the flag `litoral`
(see the README). Every earlier entry is `zone: "core"`.

**Method.** Identical to the core towns: Census Reporter API, ACS 2024 5-year (2020-2024) table B19013, county-subdivision level, release
`acs2024_5yr`, fetched 2026-10-10 from `https://api.censusreporter.org/1.0/data/show/latest?table_ids=B19013&geo_ids=060|04000US25`
(the API now rejects clients without a project-specific user agent; one such header was enough). Centroids from the Census 2024
Gazetteer county-subdivision file. Straight-line (haversine) miles to the Framingham city centroid times 1.3, rounded. The method was
checked against the existing rows first (Natick 4.7 straight-line miles, Weston 7.7, Quincy $98,882, all reproduced exactly). Tiers: A >= 175,000, B 125,000 to 174,999, C < 125,000.

**What was added: 24 towns, plus Quincy re-tagged (it was already listed, numbers kept).**

| Region | Towns | Tier A | Tier B | Tier C |
|---|---|---|---|---|
| North Shore (15, Essex County, Lynn to Salisbury) | Lynn, Nahant, Swampscott, Marblehead, Salem, Beverly, Manchester-by-the-Sea, Gloucester, Rockport, Essex, Ipswich, Rowley, Newbury, Newburyport, Salisbury | Marblehead, Manchester-by-the-Sea | Swampscott, Essex, Ipswich, Rowley, Newbury, Newburyport | Lynn, Nahant, Salem, Beverly, Gloucester, Rockport, Salisbury |
| South Shore (10, Norfolk and Plymouth County coast, Quincy to Plymouth) | Quincy (existing), Weymouth, Hull, Hingham, Cohasset, Scituate, Marshfield, Duxbury, Kingston, Plymouth | Hingham, Cohasset, Duxbury | Scituate, Marshfield | Quincy, Weymouth, Hull, Kingston, Plymouth |

The whole file now has 129 towns: tier A 31, B 52, C 46.

**Uncertainty.**
- No coastal town is top-coded at the 250,001 ACS cap.
- Margins of error are large for several small towns, so tier boundaries are soft: Newbury $174,868 (MOE 58,593) sits $132 below the tier A line; Cohasset $199,306 (MOE 53,082), Manchester-by-the-Sea $206,389 (MOE 43,757), Rowley $132,734 (MOE 32,311), Duxbury $176,583 (MOE 29,187) and Marblehead $182,132 (MOE 27,872) could each land one tier either way; Hingham $178,390 (MOE 14,719) and Marshfield $125,986 (MOE 8,316) are right at an A/B and a B/C edge.
- Distances are not routed. Coastal estimates run from 35 (Lynn, Nahant) to 66 (Plymouth) miles, plus or minus 20%. Quincy (29) and Weymouth/Hull/Hingham (34 to 38) are the closest.
- Whole-city medians hide neighbourhood differences (Lynn, Salem, Gloucester and Plymouth are C overall).
- Not added on purpose: Revere and Winthrop (Suffolk County beaches, not part of the Essex County North Shore or Plymouth/Norfolk South Shore definition used here) and inland towns that are only called "North Shore" or "South Shore" in marketing (Danvers, Peabody, Topsfield, Norwell, Pembroke, Rockland). A fair in one of them gets `distancia_desconhecida` (no penalty, flagged) unless it is added to `towns.json`.

**Sources added (3, all verified 2026-10-10 with Python `requests` and a Chrome user agent; a fair name was found in the raw bytes).**

| id | Sample found in the raw HTML |
|---|---|
| `meetmeatthefair-north-shore` | Marblehead Winter Artisan & Craft Fair 2026 (Dec 5-6, King Hooper Mansion); 27 events, 375,711 bytes. Region slug confirmed on the Massachusetts index page. |
| `meetmeatthefair-south-shore` | Plimoth Patuxet Winter Fine Arts & Craft Fair 2026 (Dec 5, Plymouth); 16 events, 253,372 bytes. |
| `patch-hingham-calendar` | Holiday Vendor Fair (Sat Dec 5, Hingham); 164,726 bytes. Low yield, kept as a late-announcement net like the other Patch calendars. |

**Checked and rejected.**
- FestivalNet `Massachusetts-craft-shows?page=4`: answers 200 but repeats Cape Cod listings already on page 3. Other FestivalNet category slugs (`holiday-shows`, `festivals`, `art-shows`) return 404.
- Boston Calendar `events?q=craft+fair`: 200 and 2 MB, but the `q` parameter is ignored (the same Boston-wide list comes back for any query), it changes every day, and its tag pages answer 500.
- See Plymouth events (`seeplymouth.com/events/`): server-rendered South Shore calendar, but it lists only the next 12 events (one day on the check date), mostly not fairs, and changes daily.
- Macaroni Kid North Shore and South Shore: static, but no fair names on the pages checked (the holiday-fairs guide is a new article each year with a new URL).
- Patch calendars for Newburyport, Gloucester, Scituate, Duxbury, Marshfield, Ipswich and Cohasset: HTTP 404. Marblehead, Salem, Beverly, Swampscott, Plymouth, Weymouth and Quincy load but had no vendor fair on the check date. Lynn, Rockport and Kingston have no calendar page.
- Chamber and arts-association pages (Newburyport, Cape Ann, Marblehead, Essex Heritage, Salem Arts Association): static or empty, no fair listing a script can diff. The Marblehead Arts Association site answers 403 to scripts.
- TheCraftMap (statewide and per-town pages) still answers HTTP 429.

Directory coverage of coastal fairs is thin, which is why the rotating town search (README, "Rotating per-town discovery") does the real work for them.
