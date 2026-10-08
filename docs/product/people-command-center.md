# People — the outreach command center

For the team using Loop day to day. How it works underneath is in
`docs/architecture/crm-people-command-center.md`.

## What you see

**CRM → People** lists every established person, with one row per person:

| Column | What it means |
|---|---|
| Person | Name, title and company. The small line says when they were established, and whether they were imported or added by hand. |
| Creator | The creator this contact was worked for, from the import or a recorded note. |
| Status | Where the conversation stands, and where that came from: *set by a person*, *from your Gmail*, *from your calendar* or *from the import*. |
| Cadence | The next follow-up step (3-day, 7-day, 14-day, monthly) and how many emails you have sent. A reply stops it. |
| Last touch | Your most recent email to them, or the import's last-contacted date. |
| Next action | What is due and when. **Overdue is red.** |
| Reply | "Replied — awaiting our response", "No reply observed through …", or "Gmail data unavailable". |
| Summary | The latest note, or the source's status when there is no note. |

The summary above the list counts the same rows: awaiting reply, due today, overdue, replies needing your
response, meetings, on hold, and more. The chips under it are one-click views ("Overdue", "Replied — needs
response", "3-day", "Meetings this week", …). Filters combine, and search finds names, titles and
companies (never an email address or phone number).

## Whose mail

Reply, cadence and meeting facts come from **your own** Gmail and Calendar. A colleague looking at the
same person sees what **their** mailbox shows, and nobody sees anyone else's mail. Titles, notes, company
and creator context, and any state or next action a person sets are shared with everyone who can see People.

If your Gmail is not connected, the page says so and does not pretend nobody replied. If Loop's last read
of your mail is older than half an hour, it says "stale" with the time of that read. Opening Mail
refreshes it.

## What you can do on a person

- **Set the conversation state:** Interested, Negotiating, Meeting scheduled, On hold, Circle back, Passed,
  Closed or Active conversation. Choose "None set" to go back to what the facts show. If they reply after
  you set a state, the reply shows first: *Replied — needs response*.
- **Set a next action** and a due date.
- **Record a note or their title.** Email addresses and phone numbers are refused in notes; they belong on
  contact points.
- **The timeline** shows everything with its source and time: imported history ("unknown time" when the
  import had none), notes, state changes, your emails and replies (with *Open in Mail*), and your meetings.
  Entries from your mail and calendar say "only you see this".

## Possible new people

**People → Possible new people** lists people you have emailed directly who are not in the CRM. It leaves
out yourself, colleagues, no-reply and newsletter senders, and shared inboxes like info@ or support@. Each
entry says why it surfaced.

- **Add to People** first shows exactly what will be created: one person, established by you, with that
  email. You confirm the name. No company, opportunity or relationship is created. If the address is
  already a person, it opens them instead. If it is a company's shared inbox, it says so and creates
  nothing.
- **Dismiss** (Ignore, Not a person, Internal, Automated, Not relevant) hides an entry from **your** queue
  only. You can restore it under *Dismissed*.

Adding someone establishes a person, which workspace owners and administrators can do.
