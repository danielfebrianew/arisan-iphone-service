# arisan-iphone-service

A backend service powering a **group-based arisan platform** where the prize is an iPhone. Members join groups, buy numbered slot tickets, and participate in scheduled draws — all managed through a structured admin and payment verification flow.

Built with **NestJS** and **MySQL**.

---

## Features

### Groups & Slots
- Create and manage arisan groups with configurable slot capacity, ticket price, and draw schedule
- Each group runs in cycles — one winner drawn per cycle
- Slot numbers are assigned sequentially per group as tickets are purchased

### Tickets & Payments
- Members purchase numbered slot tickets for each group
- Payment submission includes proof-of-transfer upload
- Admin reviews and verifies each payment before the slot is confirmed

### Draws
- Scheduled winner draws per group cycle
- Only verified ticket holders are eligible

### Referrals
- Members can invite others using a unique referral code
- Referral reward system tracks and credits successful invites

### Auth & Access Control
- JWT-based authentication
- Role-based access control (member / admin)
- Admin dashboard with activity logs and platform-wide stats

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | NestJS |
| ORM | TypeORM |
| Database | MySQL |
| Auth | JWT (Passport) |
| File Upload | Multer |
