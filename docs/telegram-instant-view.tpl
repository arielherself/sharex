# Telegram Instant View template for this app's post pages.
# Paste this into https://instantview.telegram.org/my/ for your deployed domain.

~version: "2.1"

?path: /[A-Za-z0-9_]{1,15}/status/[0-9]{5,25}/?
?exists: //article[@data-iv-post]

title: //article[@data-iv-post]/@data-iv-title
author: //article[@data-iv-post]/@data-iv-author
published_date: //article[@data-iv-post]/@data-iv-published-timestamp
description: //meta[@property="og:description"]/@content
image_url: //meta[@property="og:image"]/@content
site_name: //meta[@property="og:site_name"]/@content

body: (//article[@data-iv-post]//section[has-class("iv-body")])[1]

# Poll bars are browser UI; the option labels and percentages stay in text.
@remove: $body//progress

# Engagement counters and profile chrome are intentionally excluded from body,
# but quoted post author attribution is kept through .quote-author.
@remove: $body//*[has-class("post-footer")]
@remove: $body//*[has-class("post-header")]
