# Privacy policy addition: AI assistant (draft)

This is a **draft for the store owner to review** and adapt before adding it to the
store's privacy policy (WordPress → Settings → Privacy). It describes what this system
actually does (see `docs/design.md` D6.12). It is not legal advice; laws differ by
country (for example GDPR in the EU/UK, CCPA in California, the DPDP Act in India), so
have it checked if you sell to customers in those places.

Fill in the parts in [brackets].

---

### Use of an AI assistant by our staff

Our team uses an internal AI assistant to help run the store, for example to summarize
orders or answer questions about products and stock. The assistant runs on our own
systems and uses an AI model provided by **[Groq, Inc.]** (the "AI provider").

**What is shared with the AI provider.** When a team member asks the assistant about
orders, we send the AI provider order information such as order numbers, dates,
products, quantities, totals and status, and the city, state/region, postcode and
country of the billing address. **Before anything is sent, we replace your name and
email address with a random code and remove your phone number and street address.** The
AI provider never receives your name, email address, phone number or street address from
our order records.

**What the AI provider does with it.** The AI provider processes this information only
to generate the assistant's answer, under its API terms and data processing agreement.
[We have enabled Zero Data Retention, so the AI provider does not store this information
after answering.] The AI provider does not use it to train its models [per its API
terms].

**Where.** The AI provider may process this information in [the United States]. [Where
required, this transfer is covered by the provider's Standard Contractual Clauses / data
processing agreement.]

**Your choices.** You can ask us at [privacy contact email] which information we hold
about you, or ask us to correct or delete it, as described in the rest of this policy.

---

## Owner's checklist before publishing

- [ ] In the Groq console, open **Settings → Data Controls**
      (https://console.groq.com/settings/data-controls) and turn on Zero Data Retention if
      your plan offers it. If it doesn't, or you need a contractual guarantee, ask Groq
      about their enterprise terms. Then keep or remove the bracketed ZDR sentence above
      to match.
- [ ] Read Groq's current data-use terms and DPA, and confirm the processing location.
- [ ] Keep `CHAT_PII_MASKING` at its default (`true`). If you turn it off, this text is no
      longer accurate.
- [ ] Remember the limits (D6.12): free text a customer writes in an order note is only
      masked on a best-effort basis, and whatever staff type into the chat is sent as
      typed, apart from known customers, emails and phone numbers. Train staff not to
      paste customer details into chat.
