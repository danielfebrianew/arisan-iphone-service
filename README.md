# arisan-iphone-service

Backend service for a group-based arisan (rotating savings) platform with iPhone as the prize. Built with NestJS + MySQL.

## Features

- **Groups** — create and manage arisan groups with configurable slots, ticket price, and draw schedule
- **Tickets & Slots** — members buy numbered slot tickets; each ticket gets a sequential slot number per group
- **Payments** — payment submission with proof upload and admin verification flow
- **Draws** — scheduled winner draws per group cycle
- **Referrals** — referral reward system for inviting new members
- **Admin** — activity log, dashboard stats, and member/group management
- **Auth** — JWT-based authentication with role-based access control

## Tech Stack

- NestJS · TypeORM · MySQL
- JWT Auth · Multer (file upload)
