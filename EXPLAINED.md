# The Two Big Problems, Explained Simply

A plain-language version of `BOTTLENECKS.md` and `REGISTRY-DESIGN.md`.
No jargon. If a technical word shows up, it gets explained first.

---

## First, what you're building

A robot assistant that checks job listings for you.

Every few hours it goes out, looks at jobs, throws away the ones you'd hate, ranks the rest, and
sends you a short list once a day. You still apply yourself. It just does the boring looking-around
part.

That's a good idea. The plan for it is mostly good too. But two things in the plan won't work,
and it's much cheaper to find that out now than after you've built it.

---

# Problem 1: The robot doesn't know which companies to look at

## The phone book analogy

Imagine you want to find every restaurant in your city that serves pancakes.

**What you'd like to do:** open Google, type "pancakes near me," get a list. One question, one
answer. Easy.

**What you actually have:** a phone book. You can look up any restaurant by name and call them
to ask "do you serve pancakes?" But there is no way to ask the phone book "who serves pancakes?"
The phone book only works if you already know who you want to call.

Job listings work like the phone book, not like Google.

## Why

Most companies don't build their own careers page from scratch. They rent software to handle it.
The three most popular brands of that software are called **Greenhouse**, **Lever**, and **Ashby**.

These three brands are helpful: they let anyone look up a company's open jobs for free, no
password needed. That's genuinely great, and it's why your plan is right to use them.

But you have to ask *company by company*. Like this:

> "Greenhouse, what jobs does **Stripe** have open?" → here's the list

There is no version of this:

> "Greenhouse, which of your companies is hiring a React Native developer?" → ✗ not possible

They don't offer that. It isn't a limitation you can code around — the question simply cannot
be asked.

## Why this breaks the current plan

Your design has a piece called the **Search Module**. You feed it job titles and keywords, and
it's supposed to go find matching jobs.

That's the Google version. It assumes you can ask one big question and get answers back. But
these services only answer the phone-book version — one company at a time, by name.

So the robot needs a **list of company names** before it can do anything at all. Your plan
doesn't have one, and doesn't say where it would come from. Everything else in the pipeline is
waiting on a list that doesn't exist.

This is the single thing most worth fixing before any code gets written.

---

## The fix, in one sentence

**Stop trying to search. Get a list of companies, check all of them, and do the sorting on your
own computer afterwards.**

Instead of asking a clever question and hoping for good answers, you grab *everything* and then
be picky in private.

Concretely:

```
The old way (doesn't work):
  "find me React Native jobs"  →  ???  →  jobs

The new way (works):
  list of 15,000 companies  →  ask each one "what have you got?"
                            →  download everything
                            →  sort through it on your own machine
```

The picking-and-choosing still happens. It just happens *after* the download, on your computer,
where you're allowed to be as fussy as you like.

## A nice side effect

Because you keep everything you download, changing your mind is instant.

Say you decide you'd actually consider contract work after all. Old way: re-run the whole search
and wait. New way: you already have that data sitting on your disk — just re-sort it. Takes
seconds.

You can even ask "what did I miss last month?" and get a real answer, because nothing was thrown
away.

---

## But where does the list of 15,000 companies come from?

Here's the good news: **somebody already made it, it's free, and it updates itself daily.**

There's a public project on GitHub — an open-source website where programmers share code — that
maintains exactly this list. It's called `job-board-aggregator`. It publishes plain lists of
company names for each service:

| Service | Companies on the list |
|---|---|
| Greenhouse | 8,333 |
| Lever | 4,368 |
| Ashby | 3,161 |
| **Total** | **15,862** |

Someone else's computer rebuilds these lists every single day, for free. You just download them.

That's your starting point, and it's about an afternoon of work to load in — not the weeks it
would take to build a list yourself.

## I checked whether the list actually works

Lists like this go stale, so I didn't take it on faith. I picked 25 companies at random and
tried each one.

**14 worked. 11 didn't.** So a bit over half are still active. The other half have closed their
accounts or switched to different software since the list was made.

That sounds bad but isn't, for two reasons:

1. When a company is gone, you find out instantly and for free — you ask, and you get a "not
   found" reply. One quick check per company.
2. It tells you something important: **the list rots, so the robot has to clean it up as it
   goes.** Check them all occasionally, cross off the dead ones, and you're always current.

Better to know that now than to be confused in six months about why a third of your list returns
nothing.

## Is checking 15,000 companies actually realistic?

I measured it. Yes, easily.

| | Time |
|---|---|
| Checking all 15,862, first time | about 15 minutes |
| Every time after that | **about 2 minutes** |

The second row is the surprising one, and it's worth understanding why — see the speed section
below.

Fifteen thousand sounds like a huge number. For a computer making small web requests, it isn't.
The whole download is about 47 MB — roughly one podcast episode.

**So don't hand-pick a shortlist of companies.** I suggested that earlier and I was wrong; once I
measured it, there was no reason to limit yourself. Just take all of them. You'll find good jobs
at companies you'd never have thought to add to a shortlist, which is exactly the kind of thing
you want a robot for.

## One refinement: check favourites more often

Not every company deserves equal attention. Sort them into three buckets:

| Bucket | Who's in it | How often to check |
|---|---|---|
| **Favourites** | ~50 places you'd genuinely love to work | every 6 hours |
| **Warm** | posted something relevant recently | every 12 hours |
| **Everyone else** | the other ~15,000 | once a day |

You hear about your dream companies fast, and you still see everything eventually. Companies can
move up a bucket automatically when they post something you'd like — so the list quietly learns
your taste without you maintaining it.

---

# Problem 2: The Google trick will stop working

## What the plan currently does

Your design uses something called **Google X-Ray**. It's a real technique: you type a special
search into Google that makes it show you pages from one specific website.

The plan uses it to hunt for job pages, four times a day, forever.

## Why it breaks

Google doesn't like robots using its search box. It's built to serve people, and automated
searching costs it money while showing no ads.

So Google watches for it. When it thinks a robot is searching, it puts up one of those "click all
the traffic lights" puzzles. Your robot can't solve those. It just stops working.

Four times a day, every day, from the same computer, is an obvious pattern. **You'd get blocked
within about a week.**

The bigger issue is that your architecture diagram treats Google as an equal partner to
Greenhouse, Lever, and Ashby. If a quarter of your setup is guaranteed to break, the whole thing
feels unreliable — and you won't trust the results.

---

## The fix: give Google a different job

Don't try to make the Google trick survive. **Change what you use it for.**

Right now you're using Google to find *jobs*. But you don't need it for that — Greenhouse, Lever,
and Ashby hand you jobs directly, in clean, organised form, for free, no blocking.

What you *actually* lack is the thing from Problem 1: **company names.**

So use Google for that instead.

### Back to the phone book

You have a phone book (Greenhouse, Lever, Ashby). It works fine. Your problem was never the phone
book — it was not knowing which names to look up.

So don't use Google to ask about pancakes. **Use Google to find names to add to your phone book.**

Once Google tells you "hey, this company exists and uses Greenhouse," you never need Google for
that company again. From then on, you ask Greenhouse directly — reliably, forever, for free.

Google goes from being a source you depend on to a scout that occasionally brings back new names.

### Why this makes the blocking problem vanish

| | Before | After |
|---|---|---|
| How often it runs | 4× a day, forever | once a week |
| Searches per week | over 1,000 | about 50 |
| If Google blocks you | a quarter of your system dies | you find a few new companies late |
| Cost if you pay for it | too expensive | about **6 cents a month** |

Twenty times fewer searches takes you from "definitely blocked" to "probably fine, and cheap
enough to just pay for if not."

And notice the third row — that's the real win. Getting blocked used to break your robot. Now it
means next Monday's batch of new companies shows up a week late, and you likely wouldn't even
notice.

## Three better scouts that don't involve Google at all

Google shouldn't be your only way of finding new companies. Honestly it's the weakest one:

1. **Re-download the free list every week.** Someone else already updates it daily. Costs
   nothing, can't get blocked, finds the most companies. This should be your main method.
2. **Guess and check.** If you hear about a company anywhere — a friend, a news article, Hacker
   News' monthly "Who's hiring?" thread — just try their name against all three services. You
   get a yes or no immediately. Free, instant, unblockable.
3. **Peek at their careers page.** Visit a company's careers page and see where it sends you. If
   it lands on Greenhouse, you've learned they use Greenhouse. Done.

Use Google only for gaps the other three leave. If Google blocked you permanently tomorrow, your
list would keep growing anyway.

---

# Two speed tricks worth knowing

These aren't in your plan, and they're the difference between the robot taking 15 minutes and
taking 2. Both are simple, and both are much easier to add now than later.

## Trick 1: Ask for it squashed

When a computer sends you data, it can send it flat or squashed down (the technical word is
*compressed* — same idea as a ZIP file).

Squashing is free and automatic. You just have to ask, and most tools don't ask by default.

I tested it on a real company's job list:

```
Not asking:  325,000 units of data
Asking:       27,000 units of data     ← exactly the same information
```

**Twelve times smaller for one extra line of code.** There's no downside; it unsquashes
automatically on arrival.

## Trick 2: "Anything new since last time?"

This one's the big one.

Every time you ask a company for their jobs, they also hand you a little receipt — a short code
representing "this is what our list looked like just now."

Next time you ask, you show them the receipt. If nothing has changed, they reply **"nope, same as
before"** and send nothing at all. If something *has* changed, they send the new list.

I tested this too:

```
Normal ask:      325,000 units of data,  1.8 seconds
With receipt:              0 units,      0.5 seconds   ← nothing changed
```

Most companies don't post a new job every six hours. So most of the time, most of your 15,000
questions get answered with an instant "nothing new."

**That's why the second run takes 2 minutes instead of 15.** The robot skips almost all the work,
because almost nothing changed.

---

# Putting it together

Here's the whole thing in order:

```
ONCE A WEEK
  Go find new company names
     • re-download the free list        ← main source
     • try guesses for companies you heard about
     • peek at careers pages
     • ask Google, if the above missed something
  Add anything new to the list
  Cross off any that have shut down


EVERY FEW HOURS
  Go through the company list
     • favourites every 6 hours, everyone else once a day
     • ask squashed, and show the receipt
     • most reply "nothing new" → skip instantly
  Save every job you get, without filtering
     • don't throw anything away yet


AFTERWARDS, ON YOUR OWN COMPUTER
  Remove duplicates
  Throw out the ones you'd never want
  Score and rank what's left


ONCE A DAY, IN THE MORNING
  Send you the top jobs
```

## The two ideas underneath all of it

**1. Grab everything, be picky afterwards.** Don't ask the internet clever questions. Ask boring
questions, get everything, and be fussy in private where it's fast and free and you can change
your mind.

**2. Keep the fragile parts away from the important parts.** The daily job of fetching jobs only
touches services that are happy to be asked. The one unreliable thing — Google — got moved to a
weekly errand that nobody notices if it fails.

---

# What to do first

In order, because each one unblocks the next:

1. **Load the free company lists.** ~15,000 companies. About an afternoon. Nothing else can start
   without this.
2. **Check them all once, cross off the dead ones.** Confirms the roughly-half-alive figure with
   your own data.
3. **Add the two speed tricks** — squashing and receipts. Small now, a rewrite later.
4. **Set up the three buckets** so favourites get checked more often.
5. **Do your filtering and scoring on stored data**, not during the download.

That's the working robot. Everything after that — weekly scouting, smarter ranking — is
improvement on something that already runs.

One last thing worth adding early: **put buttons on the daily message** (*Interested / Applied /
Not for me*). It's an hour of work. Without it the robot can never learn what you actually like,
and you'll have no way to tell whether it's doing a good job. With it, every tap teaches it
something.

---

*Details, exact measurements, and the commands to reproduce them are in `BOTTLENECKS.md` and
`REGISTRY-DESIGN.md`.*
