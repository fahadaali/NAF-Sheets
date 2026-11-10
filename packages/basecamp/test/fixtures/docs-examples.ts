// Example JSON copied verbatim from the official Basecamp API docs.
// Source: github.com/basecamp/bc-api, branch master, sections/<file>.md,
// fetched from raw.githubusercontent.com on 2026-11-10. Each block cites its
// section and the SHA-256 of the doc file it was read from.
// Generated: do not edit by hand; re-copy from the docs if they change.
/* eslint-disable */

// sections/todos.md, "Get to-dos" — example response of `GET /todolists/3/todos.json`.
// sha256(todos.md) = b3fd03bfed49df0a546ef17d8b4feadf4c24eb3223c3ccafea1d47947276ee51
export const listTodosExample: unknown = [
  {
    "id": 1069480013,
    "status": "active",
    "visible_to_clients": false,
    "created_at": "2026-05-12T04:29:00.000Z",
    "updated_at": "2026-05-12T04:29:00.000Z",
    "title": "Go cutting edge: iOS8 and Android 4.5 only",
    "inherits_status": true,
    "type": "Todo",
    "url": "https://3.basecampapi.com/195539477/buckets/2085958505/todos/1069480013.json",
    "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/todos/1069480013",
    "bookmark_url": "https://3.basecampapi.com/195539477/my/bookmarks/BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiLmdpZDovL2JjMy9SZWNvcmRpbmcvMTA2OTQ4MDAxMz9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg1yZWFkYWJsZQY7AFQ=--2472c3a0728b0212f08580c0fc26d3a94b8ed8ed.json",
    "subscription_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069480013/subscription.json",
    "comments_count": 0,
    "comments_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069480013/comments.json",
    "boosts_count": 0,
    "boosts_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069480013/boosts.json",
    "subtasks_count": 0,
    "subtasks_completed_count": 0,
    "subtasks_url": "https://3.basecampapi.com/195539477/recordings/1069480013/subtasks.json",
    "position": 1,
    "parent": {
      "id": 1069480012,
      "title": "Strategy ideas",
      "type": "Todolist",
      "url": "https://3.basecampapi.com/195539477/buckets/2085958505/todolists/1069480012.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/todolists/1069480012"
    },
    "bucket": {
      "id": 2085958505,
      "name": "The Leto Laptop",
      "type": "Project"
    },
    "creator": {
      "id": 1049715938,
      "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkzOD9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--4ccc567a0a3b10e354bca909b704637b601f0b16",
      "name": "Annie Bryan",
      "personable_type": "User",
      "title": "Central Markets Manager",
      "tagline": "To open a store is easy, to keep it open is an art",
      "location": null,
      "created_at": "2026-05-28T17:22:29.167Z",
      "updated_at": "2026-05-28T17:22:29.167Z",
      "email_address": "annie@honchodesign.com",
      "bio": "To open a store is easy, to keep it open is an art",
      "admin": false,
      "owner": false,
      "client": false,
      "employee": true,
      "time_zone": "America/Chicago",
      "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOJkkT4=--732a71fbd28ec10d9bf4466abd3588a8bea40bdb/avatar",
      "company": {
        "id": 1033447817,
        "name": "Honcho Design"
      },
      "can_ping": true,
      "can_manage_projects": true,
      "can_manage_people": true,
      "can_access_timesheet": true,
      "can_access_hill_charts": true
    },
    "description": "",
    "description_attachments": [],
    "completed": false,
    "content": "Go cutting edge: iOS8 and Android 4.5 only",
    "starts_on": null,
    "due_on": null,
    "assignees": [],
    "completion_subscribers": [],
    "completion_url": "https://3.basecampapi.com/195539477/todos/1069480013/completion.json",
    "steps": []
  }
]

// sections/todos.md, "Get a to-do" — example response of `GET /todos/2.json`.
// sha256(todos.md) = b3fd03bfed49df0a546ef17d8b4feadf4c24eb3223c3ccafea1d47947276ee51
export const getTodoExample: unknown = {
  "id": 1069480015,
  "status": "active",
  "visible_to_clients": false,
  "created_at": "2026-05-12T05:24:00.000Z",
  "updated_at": "2026-07-21T01:06:20.117Z",
  "title": "Clear and simple UI",
  "inherits_status": true,
  "type": "Todo",
  "url": "https://3.basecampapi.com/195539477/buckets/2085958505/todos/1069480015.json",
  "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/todos/1069480015",
  "bookmark_url": "https://3.basecampapi.com/195539477/my/bookmarks/BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiLmdpZDovL2JjMy9SZWNvcmRpbmcvMTA2OTQ4MDAxNT9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg1yZWFkYWJsZQY7AFQ=--d60dfcd84fa8e5ca8336b0a8167cb7919846e485.json",
  "subscription_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069480015/subscription.json",
  "comments_count": 0,
  "comments_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069480015/comments.json",
  "boosts_count": 0,
  "boosts_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069480015/boosts.json",
  "subtasks_count": 0,
  "subtasks_completed_count": 0,
  "subtasks_url": "https://3.basecampapi.com/195539477/recordings/1069480015/subtasks.json",
  "parent": {
    "id": 1069480012,
    "title": "Strategy ideas",
    "type": "Todolist",
    "url": "https://3.basecampapi.com/195539477/buckets/2085958505/todolists/1069480012.json",
    "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/todolists/1069480012"
  },
  "bucket": {
    "id": 2085958505,
    "name": "The Leto Laptop",
    "type": "Project"
  },
  "creator": {
    "id": 1049715938,
    "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkzOD9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--4ccc567a0a3b10e354bca909b704637b601f0b16",
    "name": "Annie Bryan",
    "personable_type": "User",
    "title": "Central Markets Manager",
    "tagline": "To open a store is easy, to keep it open is an art",
    "location": null,
    "created_at": "2026-05-28T17:22:29.167Z",
    "updated_at": "2026-05-28T17:22:29.167Z",
    "email_address": "annie@honchodesign.com",
    "bio": "To open a store is easy, to keep it open is an art",
    "admin": false,
    "owner": false,
    "client": false,
    "employee": true,
    "time_zone": "America/Chicago",
    "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOJkkT4=--732a71fbd28ec10d9bf4466abd3588a8bea40bdb/avatar",
    "company": {
      "id": 1033447817,
      "name": "Honcho Design"
    },
    "can_ping": true,
    "can_manage_projects": true,
    "can_manage_people": true,
    "can_access_timesheet": true,
    "can_access_hill_charts": true
  },
  "description": "",
  "description_attachments": [],
  "completed": true,
  "completion": {
    "created_at": "2026-07-21T01:06:20.028Z",
    "creator": {
      "id": 1049715930,
      "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkzMD9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--322099b137f9e0b6bc944b5b9fe7a2692da94814",
      "name": "Sharon Bradford",
      "personable_type": "User",
      "title": "Principal Branding Administrator",
      "tagline": null,
      "location": null,
      "created_at": "2026-05-28T17:22:28.137Z",
      "updated_at": "2026-05-28T17:22:28.137Z",
      "email_address": "sharon@honchodesign.com",
      "bio": null,
      "admin": false,
      "owner": false,
      "client": false,
      "employee": false,
      "time_zone": "America/Chicago",
      "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBNpkkT4=--789594e5e542ab99e467a51c9dec0a9035abc0e0/avatar",
      "can_ping": true,
      "can_manage_projects": true,
      "can_manage_people": true,
      "can_access_timesheet": true,
      "can_access_hill_charts": true
    }
  },
  "content": "Clear and simple UI",
  "starts_on": null,
  "due_on": null,
  "assignees": [
    {
      "id": 1049715930,
      "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkzMD9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--322099b137f9e0b6bc944b5b9fe7a2692da94814",
      "name": "Sharon Bradford",
      "personable_type": "User",
      "title": "Principal Branding Administrator",
      "tagline": null,
      "location": null,
      "created_at": "2026-05-28T17:22:28.137Z",
      "updated_at": "2026-05-28T17:22:28.137Z",
      "email_address": "sharon@honchodesign.com",
      "bio": null,
      "admin": false,
      "owner": false,
      "client": false,
      "employee": false,
      "time_zone": "America/Chicago",
      "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBNpkkT4=--789594e5e542ab99e467a51c9dec0a9035abc0e0/avatar",
      "can_ping": true,
      "can_manage_projects": true,
      "can_manage_people": true,
      "can_access_timesheet": true,
      "can_access_hill_charts": true
    }
  ],
  "completion_subscribers": [
    {
      "id": 1049715930,
      "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkzMD9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--322099b137f9e0b6bc944b5b9fe7a2692da94814",
      "name": "Sharon Bradford",
      "personable_type": "User",
      "title": "Principal Branding Administrator",
      "tagline": null,
      "location": null,
      "created_at": "2026-05-28T17:22:28.137Z",
      "updated_at": "2026-05-28T17:22:28.137Z",
      "email_address": "sharon@honchodesign.com",
      "bio": null,
      "admin": false,
      "owner": false,
      "client": false,
      "employee": false,
      "time_zone": "America/Chicago",
      "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBNpkkT4=--789594e5e542ab99e467a51c9dec0a9035abc0e0/avatar",
      "can_ping": true,
      "can_manage_projects": true,
      "can_manage_people": true,
      "can_access_timesheet": true,
      "can_access_hill_charts": true
    }
  ],
  "completion_url": "https://3.basecampapi.com/195539477/todos/1069480015/completion.json",
  "steps": []
}

// sections/subtasks.md, "Get a recording's subtasks" — example response of `GET /recordings/3/subtasks.json`.
// sha256(subtasks.md) = 05dfc729a45b8ec9acffe2c16f654a468c84def2f55b67b56f0cca19b14ed913
export const listSubtasksExample: unknown = [
  {
    "id": 1069479877,
    "status": "active",
    "visible_to_clients": false,
    "created_at": "2026-07-02T00:23:00.000Z",
    "updated_at": "2026-07-02T00:23:00.000Z",
    "title": "Hero shot on the desk",
    "inherits_status": true,
    "type": "Kanban::Step",
    "url": "https://3.basecampapi.com/195539477/buckets/2085958504/subtasks/1069479877.json",
    "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/todos/1069479876#__recording_1069479877",
    "bookmark_url": "https://3.basecampapi.com/195539477/my/bookmarks/BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiLmdpZDovL2JjMy9SZWNvcmRpbmcvMTA2OTQ3OTg3Nz9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg1yZWFkYWJsZQY7AFQ=--266e5283e4c42aa18671e82d04300ff0bb59db40.json",
    "position": 1,
    "parent": {
      "id": 1069479876,
      "title": "Shot list - indoor and outdoor",
      "type": "Todo",
      "url": "https://3.basecampapi.com/195539477/buckets/2085958504/todos/1069479876.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/todos/1069479876"
    },
    "bucket": {
      "id": 2085958504,
      "name": "The Leto Laptop",
      "type": "Project"
    },
    "creator": {
      "id": 1049715929,
      "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkyOT9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--d79103e78a10cd9f8ecda7470ea315674ac8a79a",
      "name": "Matt Donahue",
      "personable_type": "User",
      "title": "Global Data Strategist",
      "tagline": null,
      "location": null,
      "created_at": "2026-08-12T12:01:07.949Z",
      "updated_at": "2026-08-12T12:01:07.949Z",
      "email_address": "matt@honchodesign.com",
      "bio": null,
      "admin": false,
      "owner": false,
      "client": false,
      "employee": false,
      "time_zone": "America/Chicago",
      "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBNlkkT4=--0f3c77d8c13069d514fd3f0ad694a67e426bad0f/avatar",
      "can_ping": true,
      "can_manage_projects": true,
      "can_manage_people": true,
      "can_access_timesheet": true,
      "can_access_hill_charts": true
    },
    "completed": false,
    "due_on": null,
    "assignees": [],
    "completion_url": "https://3.basecampapi.com/195539477/subtasks/1069479877/completion.json"
  }
]

// sections/subtasks.md, "Get a subtask" — example response of `GET /subtasks/2.json`.
// sha256(subtasks.md) = 05dfc729a45b8ec9acffe2c16f654a468c84def2f55b67b56f0cca19b14ed913
export const getSubtaskExample: unknown = {
  "id": 1069479879,
  "status": "active",
  "visible_to_clients": false,
  "created_at": "2026-07-02T02:18:00.000Z",
  "updated_at": "2026-07-02T02:18:00.000Z",
  "title": "Outdoors, natural light",
  "inherits_status": true,
  "type": "Kanban::Step",
  "url": "https://3.basecampapi.com/195539477/buckets/2085958504/subtasks/1069479879.json",
  "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/todos/1069479876#__recording_1069479879",
  "bookmark_url": "https://3.basecampapi.com/195539477/my/bookmarks/BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiLmdpZDovL2JjMy9SZWNvcmRpbmcvMTA2OTQ3OTg3OT9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg1yZWFkYWJsZQY7AFQ=--5b8a6fa77957d7d7efbdfb7e0e301a6ca5b61787.json",
  "position": 3,
  "parent": {
    "id": 1069479876,
    "title": "Shot list - indoor and outdoor",
    "type": "Todo",
    "url": "https://3.basecampapi.com/195539477/buckets/2085958504/todos/1069479876.json",
    "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/todos/1069479876"
  },
  "bucket": {
    "id": 2085958504,
    "name": "The Leto Laptop",
    "type": "Project"
  },
  "creator": {
    "id": 1049715929,
    "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkyOT9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--d79103e78a10cd9f8ecda7470ea315674ac8a79a",
    "name": "Matt Donahue",
    "personable_type": "User",
    "title": "Global Data Strategist",
    "tagline": null,
    "location": null,
    "created_at": "2026-08-12T12:01:07.949Z",
    "updated_at": "2026-08-12T12:01:07.949Z",
    "email_address": "matt@honchodesign.com",
    "bio": null,
    "admin": false,
    "owner": false,
    "client": false,
    "employee": false,
    "time_zone": "America/Chicago",
    "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBNlkkT4=--0f3c77d8c13069d514fd3f0ad694a67e426bad0f/avatar",
    "can_ping": true,
    "can_manage_projects": true,
    "can_manage_people": true,
    "can_access_timesheet": true,
    "can_access_hill_charts": true
  },
  "completed": false,
  "due_on": null,
  "assignees": [
    {
      "id": 1049715938,
      "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkzOD9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--4ccc567a0a3b10e354bca909b704637b601f0b16",
      "name": "Annie Bryan",
      "personable_type": "User",
      "title": "Central Markets Manager",
      "tagline": "To open a store is easy, to keep it open is an art",
      "location": null,
      "created_at": "2026-08-12T12:01:09.160Z",
      "updated_at": "2026-08-12T12:01:09.160Z",
      "email_address": "annie@honchodesign.com",
      "bio": "To open a store is easy, to keep it open is an art",
      "admin": false,
      "owner": false,
      "client": false,
      "employee": true,
      "time_zone": "America/Chicago",
      "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOJkkT4=--732a71fbd28ec10d9bf4466abd3588a8bea40bdb/avatar",
      "company": {
        "id": 1033447817,
        "name": "Honcho Design"
      },
      "can_ping": true,
      "can_manage_projects": true,
      "can_manage_people": true,
      "can_access_timesheet": true,
      "can_access_hill_charts": true
    }
  ],
  "completion_url": "https://3.basecampapi.com/195539477/subtasks/1069479879/completion.json"
}

// sections/todolists.md, "Get to-do lists" — example response of `GET /todosets/3/todolists.json`.
// sha256(todolists.md) = 81ed031d42da59a425b5e7938b0ab1c86927a24fa12a2a57cecd7c4a72bd2e52
export const listTodolistsExample: unknown = [
  {
    "id": 1069480012,
    "status": "active",
    "visible_to_clients": false,
    "created_at": "2026-05-12T04:27:00.000Z",
    "updated_at": "2026-07-21T00:06:16.451Z",
    "title": "Strategy ideas",
    "inherits_status": true,
    "type": "Todolist",
    "url": "https://3.basecampapi.com/195539477/buckets/2085958505/todolists/1069480012.json",
    "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/todolists/1069480012",
    "bookmark_url": "https://3.basecampapi.com/195539477/my/bookmarks/BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiLmdpZDovL2JjMy9SZWNvcmRpbmcvMTA2OTQ4MDAxMj9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg1yZWFkYWJsZQY7AFQ=--cfb66070fa4900acb4d47211d84e218c14831c7a.json",
    "subscription_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069480012/subscription.json",
    "comments_count": 0,
    "comments_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069480012/comments.json",
    "boosts_count": 0,
    "boosts_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069480012/boosts.json",
    "position": 3,
    "parent": {
      "id": 1069479829,
      "title": "To-dos",
      "type": "Todoset",
      "url": "https://3.basecampapi.com/195539477/buckets/2085958505/todosets/1069479829.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/todosets/1069479829"
    },
    "bucket": {
      "id": 2085958505,
      "name": "The Leto Laptop",
      "type": "Project"
    },
    "creator": {
      "id": 1049715913,
      "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkxMz9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--e627c45e6b34e08862da23906862412620e4d5d9",
      "name": "Victor Cooper",
      "personable_type": "User",
      "title": "Chief Strategist",
      "tagline": "Don't let your dreams be dreams",
      "location": "Chicago, IL",
      "created_at": "2026-05-28T17:22:22.069Z",
      "updated_at": "2026-07-21T00:05:55.167Z",
      "email_address": "victor@honchodesign.com",
      "bio": "Don't let your dreams be dreams",
      "admin": true,
      "owner": true,
      "client": false,
      "employee": true,
      "time_zone": "America/Chicago",
      "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBMlkkT4=--5fe7b70fbee7a7f0e2e1e19df7579e5d880c753d/avatar",
      "company": {
        "id": 1033447817,
        "name": "Honcho Design"
      },
      "can_ping": true,
      "can_manage_projects": true,
      "can_manage_people": true,
      "can_access_timesheet": true,
      "can_access_hill_charts": true
    },
    "description": "",
    "description_attachments": [],
    "completed": false,
    "completed_ratio": "2/5",
    "name": "Strategy ideas",
    "color": null,
    "groups_url": "https://3.basecampapi.com/195539477/buckets/2085958505/todolists/1069480012/groups.json",
    "todos_url": "https://3.basecampapi.com/195539477/buckets/2085958505/todolists/1069480012/todos.json",
    "app_todos_url": "https://3.basecamp.com/195539477/buckets/2085958505/todolists/1069480012/todos",
    "comments_app_url": "https://3.basecamp.com/195539477/buckets/2085958505/recordings/1069480012/comments"
  }
]

// sections/todolists.md, "Get a to-do list" — example response of `GET /todolists/2.json`.
// sha256(todolists.md) = 81ed031d42da59a425b5e7938b0ab1c86927a24fa12a2a57cecd7c4a72bd2e52
export const getTodolistExample: unknown = {
  "id": 1069479863,
  "status": "active",
  "visible_to_clients": false,
  "created_at": "2026-04-16T23:22:00.000Z",
  "updated_at": "2026-07-21T01:05:29.822Z",
  "title": "Background and research",
  "inherits_status": true,
  "type": "Todolist",
  "url": "https://3.basecampapi.com/195539477/buckets/2085958505/todolists/1069479863.json",
  "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/todolists/1069479863",
  "bookmark_url": "https://3.basecampapi.com/195539477/my/bookmarks/BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiLmdpZDovL2JjMy9SZWNvcmRpbmcvMTA2OTQ3OTg2Mz9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg1yZWFkYWJsZQY7AFQ=--d86bbb914defcac2db83950d3e617035efd1f679.json",
  "subscription_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069479863/subscription.json",
  "comments_count": 0,
  "comments_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069479863/comments.json",
  "boosts_count": 0,
  "boosts_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069479863/boosts.json",
  "position": 12,
  "parent": {
    "id": 1069479829,
    "title": "To-dos",
    "type": "Todoset",
    "url": "https://3.basecampapi.com/195539477/buckets/2085958505/todosets/1069479829.json",
    "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/todosets/1069479829"
  },
  "bucket": {
    "id": 2085958505,
    "name": "The Leto Laptop",
    "type": "Project"
  },
  "creator": {
    "id": 1049715913,
    "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkxMz9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--e627c45e6b34e08862da23906862412620e4d5d9",
    "name": "Victor Cooper",
    "personable_type": "User",
    "title": "Chief Strategist",
    "tagline": "Don't let your dreams be dreams",
    "location": "Chicago, IL",
    "created_at": "2026-05-28T17:22:22.069Z",
    "updated_at": "2026-07-21T00:05:55.167Z",
    "email_address": "victor@honchodesign.com",
    "bio": "Don't let your dreams be dreams",
    "admin": true,
    "owner": true,
    "client": false,
    "employee": true,
    "time_zone": "America/Chicago",
    "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBMlkkT4=--5fe7b70fbee7a7f0e2e1e19df7579e5d880c753d/avatar",
    "company": {
      "id": 1033447817,
      "name": "Honcho Design"
    },
    "can_ping": true,
    "can_manage_projects": true,
    "can_manage_people": true,
    "can_access_timesheet": true,
    "can_access_hill_charts": true
  },
  "description": "",
  "description_attachments": [],
  "completed": false,
  "completed_ratio": "1/5",
  "name": "Background and research",
  "color": "blue",
  "groups_url": "https://3.basecampapi.com/195539477/buckets/2085958505/todolists/1069479863/groups.json",
  "todos_url": "https://3.basecampapi.com/195539477/buckets/2085958505/todolists/1069479863/todos.json",
  "app_todos_url": "https://3.basecamp.com/195539477/buckets/2085958505/todolists/1069479863/todos",
  "comments_app_url": "https://3.basecamp.com/195539477/buckets/2085958505/recordings/1069479863/comments"
}

// sections/projects.md, "Get a project" — example response of `GET /projects/1.json`.
// sha256(projects.md) = d606edde9f1c8caa6b9896c5ab7651415eb2964871d6d40f11ffed0c2d336aa6
export const getProjectExample: unknown = {
  "id": 2085958504,
  "status": "active",
  "created_at": "2026-07-29T18:30:00.000Z",
  "updated_at": "2026-09-12T08:21:50.481Z",
  "name": "The Leto Laptop",
  "description": "Laptop product launch.",
  "purpose": "topic",
  "clients_enabled": false,
  "timesheet_enabled": true,
  "color": null,
  "bookmark_url": "https://3.basecampapi.com/195539477/my/bookmarks/BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9CdWNrZXQvMjA4NTk1ODUwND9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg1yZWFkYWJsZQY7AFQ=--63c6529d88eaffe640cc1ca84888819d8d327108.json",
  "star_url": "https://3.basecampapi.com/195539477/buckets/2085958504/stars.json",
  "url": "https://3.basecampapi.com/195539477/projects/2085958504.json",
  "app_url": "https://3.basecamp.com/195539477/projects/2085958504",
  "dock": [
    {
      "id": 1069479829,
      "title": "Message Board",
      "name": "message_board",
      "enabled": true,
      "position": 1,
      "url": "https://3.basecampapi.com/195539477/buckets/2085958504/message_boards/1069479829.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/message_boards/1069479829"
    },
    {
      "id": 1069479830,
      "title": "To-dos",
      "name": "todoset",
      "enabled": true,
      "position": 2,
      "url": "https://3.basecampapi.com/195539477/buckets/2085958504/todosets/1069479830.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/todosets/1069479830"
    },
    {
      "id": 1069479831,
      "title": "Docs & Files",
      "name": "vault",
      "enabled": true,
      "position": 3,
      "url": "https://3.basecampapi.com/195539477/buckets/2085958504/vaults/1069479831.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/vaults/1069479831"
    },
    {
      "id": 1069479832,
      "title": "Calendar",
      "name": "schedule",
      "enabled": true,
      "position": 4,
      "url": "https://3.basecampapi.com/195539477/buckets/2085958504/schedules/1069479832.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/schedules/1069479832"
    },
    {
      "id": 1069479833,
      "title": "Chat",
      "name": "chat",
      "enabled": true,
      "position": 5,
      "url": "https://3.basecampapi.com/195539477/buckets/2085958504/chats/1069479833.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/chats/1069479833"
    },
    {
      "id": 1069479834,
      "title": "Card Table",
      "name": "kanban_board",
      "enabled": true,
      "position": 7,
      "url": "https://3.basecampapi.com/195539477/buckets/2085958504/card_tables/1069479834.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/card_tables/1069479834"
    },
    {
      "id": 1069479840,
      "title": "Automatic Check-ins",
      "name": "questionnaire",
      "enabled": true,
      "position": 6,
      "url": "https://3.basecampapi.com/195539477/buckets/2085958504/questionnaires/1069479840.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/questionnaires/1069479840"
    },
    {
      "id": 1069479841,
      "title": "Email Forwards",
      "name": "inbox",
      "enabled": false,
      "position": null,
      "url": "https://3.basecampapi.com/195539477/buckets/2085958504/inboxes/1069479841.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/inboxes/1069479841"
    },
    {
      "id": 1069480307,
      "title": "Client onboarding",
      "name": "kanban_board",
      "enabled": true,
      "position": 8,
      "url": "https://3.basecampapi.com/195539477/buckets/2085958504/card_tables/1069480307.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/card_tables/1069480307"
    }
  ],
  "people": {
    "team": {
      "count": 8,
      "sample": [
        {
          "id": 1049715938,
          "name": "Annie Bryan",
          "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOJkkT4=--732a71fbd28ec10d9bf4466abd3588a8bea40bdb/avatar"
        },
        {
          "id": 1049715939,
          "name": "Cheryl Walters",
          "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBONkkT4=--b57b5a44335d4c3ba1a2585abd6e5c7e4c85fdd6/avatar"
        },
        {
          "id": 1049715940,
          "name": "Jared Davis",
          "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBORkkT4=--2667d9ced3ec021946197cbb6c3083f0f95f3b6a/avatar"
        },
        {
          "id": 1049715941,
          "name": "Jennifer Hemmersmith Young",
          "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOVkkT4=--33e3fc268c87411378691c71b6f13658e0b40967/avatar"
        },
        {
          "id": 1049715942,
          "name": "Josh Fiske",
          "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOZkkT4=--b8553b154990a1112ab6275b749296c4a3b56334/avatar"
        },
        {
          "id": 1049715943,
          "name": "Nicole Katz",
          "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOdkkT4=--1d2b80e583133f93afe008f88166b674fc0287a4/avatar"
        },
        {
          "id": 1049715944,
          "name": "Steve Marsh",
          "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOhkkT4=--b169e35b345bcc26eca6964b7ef7de2c16b6f238/avatar"
        },
        {
          "id": 1049715913,
          "name": "Victor Cooper",
          "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBMlkkT4=--5fe7b70fbee7a7f0e2e1e19df7579e5d880c753d/avatar"
        }
      ]
    }
  },
  "all_access": false,
  "bookmarked": false,
  "starred": false
}

// sections/projects.md, "Get all projects" — example response of `GET /projects.json`.
// sha256(projects.md) = d606edde9f1c8caa6b9896c5ab7651415eb2964871d6d40f11ffed0c2d336aa6
export const listProjectsExample: unknown = [
  {
    "id": 2085958504,
    "status": "active",
    "created_at": "2026-07-29T18:30:00.000Z",
    "updated_at": "2026-09-12T08:21:50.481Z",
    "name": "The Leto Laptop",
    "description": "Laptop product launch.",
    "purpose": "topic",
    "clients_enabled": false,
    "timesheet_enabled": true,
    "color": null,
    "bookmark_url": "https://3.basecampapi.com/195539477/my/bookmarks/BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9CdWNrZXQvMjA4NTk1ODUwND9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg1yZWFkYWJsZQY7AFQ=--63c6529d88eaffe640cc1ca84888819d8d327108.json",
    "star_url": "https://3.basecampapi.com/195539477/buckets/2085958504/stars.json",
    "url": "https://3.basecampapi.com/195539477/projects/2085958504.json",
    "app_url": "https://3.basecamp.com/195539477/projects/2085958504",
    "dock": [
      {
        "id": 1069479829,
        "title": "Message Board",
        "name": "message_board",
        "enabled": true,
        "position": 1,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958504/message_boards/1069479829.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/message_boards/1069479829"
      },
      {
        "id": 1069479830,
        "title": "To-dos",
        "name": "todoset",
        "enabled": true,
        "position": 2,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958504/todosets/1069479830.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/todosets/1069479830"
      },
      {
        "id": 1069479831,
        "title": "Docs & Files",
        "name": "vault",
        "enabled": true,
        "position": 3,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958504/vaults/1069479831.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/vaults/1069479831"
      },
      {
        "id": 1069479832,
        "title": "Calendar",
        "name": "schedule",
        "enabled": true,
        "position": 4,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958504/schedules/1069479832.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/schedules/1069479832"
      },
      {
        "id": 1069479833,
        "title": "Chat",
        "name": "chat",
        "enabled": true,
        "position": 5,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958504/chats/1069479833.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/chats/1069479833"
      },
      {
        "id": 1069479834,
        "title": "Card Table",
        "name": "kanban_board",
        "enabled": true,
        "position": 7,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958504/card_tables/1069479834.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/card_tables/1069479834"
      },
      {
        "id": 1069479840,
        "title": "Automatic Check-ins",
        "name": "questionnaire",
        "enabled": true,
        "position": 6,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958504/questionnaires/1069479840.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/questionnaires/1069479840"
      },
      {
        "id": 1069479841,
        "title": "Email Forwards",
        "name": "inbox",
        "enabled": false,
        "position": null,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958504/inboxes/1069479841.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/inboxes/1069479841"
      },
      {
        "id": 1069480307,
        "title": "Client onboarding",
        "name": "kanban_board",
        "enabled": true,
        "position": 8,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958504/card_tables/1069480307.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958504/card_tables/1069480307"
      }
    ],
    "people": {
      "team": {
        "count": 8,
        "sample": [
          {
            "id": 1049715938,
            "name": "Annie Bryan",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOJkkT4=--732a71fbd28ec10d9bf4466abd3588a8bea40bdb/avatar"
          },
          {
            "id": 1049715939,
            "name": "Cheryl Walters",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBONkkT4=--b57b5a44335d4c3ba1a2585abd6e5c7e4c85fdd6/avatar"
          },
          {
            "id": 1049715940,
            "name": "Jared Davis",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBORkkT4=--2667d9ced3ec021946197cbb6c3083f0f95f3b6a/avatar"
          },
          {
            "id": 1049715941,
            "name": "Jennifer Hemmersmith Young",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOVkkT4=--33e3fc268c87411378691c71b6f13658e0b40967/avatar"
          },
          {
            "id": 1049715942,
            "name": "Josh Fiske",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOZkkT4=--b8553b154990a1112ab6275b749296c4a3b56334/avatar"
          },
          {
            "id": 1049715943,
            "name": "Nicole Katz",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOdkkT4=--1d2b80e583133f93afe008f88166b674fc0287a4/avatar"
          },
          {
            "id": 1049715944,
            "name": "Steve Marsh",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOhkkT4=--b169e35b345bcc26eca6964b7ef7de2c16b6f238/avatar"
          },
          {
            "id": 1049715913,
            "name": "Victor Cooper",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBMlkkT4=--5fe7b70fbee7a7f0e2e1e19df7579e5d880c753d/avatar"
          }
        ]
      }
    },
    "all_access": false,
    "bookmarked": false,
    "starred": false
  },
  {
    "id": 2085958505,
    "status": "active",
    "created_at": "2026-07-29T17:16:00.000Z",
    "updated_at": "2026-09-12T08:19:06.771Z",
    "name": "The Leto Locator",
    "description": "New software and hardware built for locating and securing Leto products.",
    "purpose": "topic",
    "clients_enabled": false,
    "timesheet_enabled": false,
    "color": null,
    "bookmark_url": "https://3.basecampapi.com/195539477/my/bookmarks/BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9CdWNrZXQvMjA4NTk1ODUwNT9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg1yZWFkYWJsZQY7AFQ=--427e605de283e100f75da40006030176fd863024.json",
    "star_url": "https://3.basecampapi.com/195539477/buckets/2085958505/stars.json",
    "url": "https://3.basecampapi.com/195539477/projects/2085958505.json",
    "app_url": "https://3.basecamp.com/195539477/projects/2085958505",
    "client_company": {
      "id": 1033447818,
      "name": "Leto Brand"
    },
    "clientside": {
      "url": "https://3.basecampapi.com/195539477/buckets/2085958505/client/board.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/client/board"
    },
    "dock": [
      {
        "id": 1069480049,
        "title": "Message Board",
        "name": "message_board",
        "enabled": true,
        "position": 1,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958505/message_boards/1069480049.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/message_boards/1069480049"
      },
      {
        "id": 1069480050,
        "title": "To-dos",
        "name": "todoset",
        "enabled": true,
        "position": 2,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958505/todosets/1069480050.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/todosets/1069480050"
      },
      {
        "id": 1069480051,
        "title": "Docs & Files",
        "name": "vault",
        "enabled": true,
        "position": 3,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958505/vaults/1069480051.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/vaults/1069480051"
      },
      {
        "id": 1069480052,
        "title": "Calendar",
        "name": "schedule",
        "enabled": true,
        "position": 4,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958505/schedules/1069480052.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/schedules/1069480052"
      },
      {
        "id": 1069480053,
        "title": "Chat",
        "name": "chat",
        "enabled": true,
        "position": 5,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958505/chats/1069480053.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/chats/1069480053"
      },
      {
        "id": 1069480054,
        "title": "Card Table",
        "name": "kanban_board",
        "enabled": false,
        "position": null,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958505/card_tables/1069480054.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/card_tables/1069480054"
      },
      {
        "id": 1069480060,
        "title": "Automatic Check-ins",
        "name": "questionnaire",
        "enabled": false,
        "position": null,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958505/questionnaires/1069480060.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/questionnaires/1069480060"
      },
      {
        "id": 1069480061,
        "title": "Email Forwards",
        "name": "inbox",
        "enabled": false,
        "position": null,
        "url": "https://3.basecampapi.com/195539477/buckets/2085958505/inboxes/1069480061.json",
        "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/inboxes/1069480061"
      }
    ],
    "people": {
      "team": {
        "count": 8,
        "sample": [
          {
            "id": 1049715938,
            "name": "Annie Bryan",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOJkkT4=--732a71fbd28ec10d9bf4466abd3588a8bea40bdb/avatar"
          },
          {
            "id": 1049715939,
            "name": "Cheryl Walters",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBONkkT4=--b57b5a44335d4c3ba1a2585abd6e5c7e4c85fdd6/avatar"
          },
          {
            "id": 1049715940,
            "name": "Jared Davis",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBORkkT4=--2667d9ced3ec021946197cbb6c3083f0f95f3b6a/avatar"
          },
          {
            "id": 1049715941,
            "name": "Jennifer Hemmersmith Young",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOVkkT4=--33e3fc268c87411378691c71b6f13658e0b40967/avatar"
          },
          {
            "id": 1049715942,
            "name": "Josh Fiske",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOZkkT4=--b8553b154990a1112ab6275b749296c4a3b56334/avatar"
          },
          {
            "id": 1049715943,
            "name": "Nicole Katz",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOdkkT4=--1d2b80e583133f93afe008f88166b674fc0287a4/avatar"
          },
          {
            "id": 1049715944,
            "name": "Steve Marsh",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOhkkT4=--b169e35b345bcc26eca6964b7ef7de2c16b6f238/avatar"
          },
          {
            "id": 1049715913,
            "name": "Victor Cooper",
            "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBMlkkT4=--5fe7b70fbee7a7f0e2e1e19df7579e5d880c753d/avatar"
          }
        ]
      }
    },
    "all_access": false,
    "bookmarked": false,
    "starred": false
  }
]

// sections/people.md, "Get all people" — example response of `GET /people.json`.
// sha256(people.md) = 306dec6f9559bf053437eb5726323e64204fd5ad2134c51930e14750c8b8d78e
export const listPeopleExample: unknown = [
  {
    "id": 1049715913,
    "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkxMz9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--e627c45e6b34e08862da23906862412620e4d5d9",
    "name": "Victor Cooper",
    "personable_type": "User",
    "title": "Chief Strategist",
    "tagline": "Don't let your dreams be dreams",
    "location": "Chicago, IL",
    "created_at": "2026-05-28T17:22:22.069Z",
    "updated_at": "2026-07-21T00:05:55.167Z",
    "email_address": "victor@honchodesign.com",
    "bio": "Don't let your dreams be dreams",
    "admin": true,
    "owner": true,
    "client": false,
    "employee": true,
    "time_zone": "America/Chicago",
    "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBMlkkT4=--5fe7b70fbee7a7f0e2e1e19df7579e5d880c753d/avatar",
    "company": {
      "id": 1033447817,
      "name": "Honcho Design"
    },
    "can_ping": true,
    "can_manage_projects": true,
    "can_manage_people": true,
    "can_access_timesheet": true,
    "can_access_hill_charts": true
  }
]

// sections/people.md, "Get person" — example response of `GET /people/2.json`.
// sha256(people.md) = 306dec6f9559bf053437eb5726323e64204fd5ad2134c51930e14750c8b8d78e
export const getPersonExample: unknown = {
  "id": 1049715928,
  "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkyOD9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--35b1370e6239e9a565c0e8f66bed307c7cc488b6",
  "name": "Mark Campbell",
  "personable_type": "User",
  "title": "Principal Markets Supervisor",
  "tagline": null,
  "location": null,
  "created_at": "2026-05-28T17:22:27.508Z",
  "updated_at": "2026-05-28T17:22:27.508Z",
  "email_address": "mark@honchodesign.com",
  "bio": null,
  "admin": false,
  "owner": false,
  "client": false,
  "employee": false,
  "time_zone": "America/Chicago",
  "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBNhkkT4=--cef810620a2f44a2144ab788d90679e478ea2344/avatar",
  "can_ping": true,
  "can_manage_projects": true,
  "can_manage_people": true,
  "can_access_timesheet": true,
  "can_access_hill_charts": true
}

// sections/people.md, "Update who can access a project" — example response of `PUT /projects/1/people/users.json`.
// sha256(people.md) = 306dec6f9559bf053437eb5726323e64204fd5ad2134c51930e14750c8b8d78e
export const updateProjectAccessExample: unknown = {
  "granted": [
    {
      "id": 1049715915,
      "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkxNT9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--56bb1f99675fd8fe08f93a706a5d2ddaa8412625",
      "name": "Amy Rivera",
      "personable_type": "User",
      "title": "Central Web Coordinator",
      "tagline": "I never said most of the things I said",
      "location": null,
      "created_at": "2026-05-28T17:22:23.206Z",
      "updated_at": "2026-05-28T17:22:23.206Z",
      "email_address": "amy@honchodesign.com",
      "bio": "I never said most of the things I said",
      "admin": false,
      "owner": false,
      "client": false,
      "employee": false,
      "time_zone": "America/Chicago",
      "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBMtkkT4=--9927c47a4cbee30a7f9aea667882496aba799149/avatar",
      "can_ping": true,
      "can_manage_projects": true,
      "can_manage_people": true,
      "can_access_timesheet": true,
      "can_access_hill_charts": true
    },
    {
      "id": 1049715956,
      "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTk1Nj9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--e842ca0bf3c9a7c8d03a4dede5fd838e947fe5c1",
      "name": "Victor Copper",
      "personable_type": "User",
      "title": "Prankster",
      "tagline": null,
      "location": null,
      "created_at": "2026-07-21T01:05:54.042Z",
      "updated_at": "2026-07-21T01:05:54.042Z",
      "email_address": "victor@hanchodesign.com",
      "bio": null,
      "admin": false,
      "owner": false,
      "client": false,
      "employee": false,
      "time_zone": "America/Chicago",
      "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBPRkkT4=--a31ea55b015ce2f5f714df6e51f42245d949ed3a/avatar",
      "company": {
        "id": 1033447819,
        "name": "Hancho Design"
      },
      "can_ping": true,
      "can_manage_projects": true,
      "can_manage_people": true,
      "can_access_timesheet": true,
      "can_access_hill_charts": true
    }
  ],
  "revoked": [
    {
      "id": 1049715944,
      "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTk0ND9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--5c49e7f857f7a2aea319ae399f8b00eb63123ef9",
      "name": "Steve Marsh",
      "personable_type": "User",
      "title": "Legacy Directives Strategist",
      "tagline": "You can do it!",
      "location": null,
      "created_at": "2026-05-28T17:22:31.108Z",
      "updated_at": "2026-05-28T17:22:31.108Z",
      "email_address": "steve@honchodesign.com",
      "bio": "You can do it!",
      "admin": false,
      "owner": false,
      "client": false,
      "employee": true,
      "time_zone": "America/Chicago",
      "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOhkkT4=--b169e35b345bcc26eca6964b7ef7de2c16b6f238/avatar",
      "company": {
        "id": 1033447817,
        "name": "Honcho Design"
      },
      "can_ping": true,
      "can_manage_projects": true,
      "can_manage_people": true,
      "can_access_timesheet": true,
      "can_access_hill_charts": true
    }
  ]
}

// sections/people.md, "Enroll people" — example response of `POST /account/enrollments/people.json`.
// sha256(people.md) = 306dec6f9559bf053437eb5726323e64204fd5ad2134c51930e14750c8b8d78e
export const enrollPeopleExample: unknown = [
  {
    "status": "created",
    "id": 1049715956,
    "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTk1Nj9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--e842ca0bf3c9a7c8d03a4dede5fd838e947fe5c1",
    "name": "Victor Copper",
    "personable_type": "User",
    "title": "Prankster",
    "tagline": null,
    "location": null,
    "created_at": "2026-07-21T01:05:54.042Z",
    "updated_at": "2026-07-21T01:05:54.042Z",
    "email_address": "victor@hanchodesign.com",
    "bio": null,
    "admin": false,
    "owner": false,
    "client": false,
    "employee": false,
    "time_zone": "America/Chicago",
    "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBPRkkT4=--a31ea55b015ce2f5f714df6e51f42245d949ed3a/avatar",
    "company": {
      "id": 1033447819,
      "name": "Hancho Design"
    },
    "can_ping": true,
    "can_manage_projects": false,
    "can_manage_people": false,
    "can_access_timesheet": false,
    "can_access_hill_charts": true
  },
  {
    "status": "existing",
    "id": 1049715915,
    "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkxNT9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--56bb1f99675fd8fe08f93a706a5d2ddaa8412625",
    "name": "Amy Rivera",
    "personable_type": "User",
    "title": "Central Web Coordinator",
    "tagline": "I never said most of the things I said",
    "location": null,
    "created_at": "2026-05-28T17:22:23.206Z",
    "updated_at": "2026-05-28T17:22:23.206Z",
    "email_address": "amy@honchodesign.com",
    "bio": "I never said most of the things I said",
    "admin": false,
    "owner": false,
    "client": false,
    "employee": false,
    "time_zone": "America/Chicago",
    "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBMtkkT4=--9927c47a4cbee30a7f9aea667882496aba799149/avatar",
    "can_ping": true,
    "can_manage_projects": true,
    "can_manage_people": true,
    "can_access_timesheet": true,
    "can_access_hill_charts": true
  }
]

// sections/webhooks.md, "Get webhooks" — example response of `GET /buckets/1/webhooks.json`.
// sha256(webhooks.md) = 3882fa071293971f5f913d647b5a7867645d16ec06a61abb0518b2c4863f7664
export const listWebhooksExample: unknown = [
  {
    "id": 1051369971,
    "active": true,
    "created_at": "2026-05-28T17:29:05.487Z",
    "updated_at": "2026-05-28T17:29:05.487Z",
    "payload_url": "https://example.com/endpoint",
    "types": [
      "all"
    ],
    "url": "https://3.basecampapi.com/195539477/buckets/2085958505/webhooks/1051369971.json",
    "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/webhooks/1051369971"
  }
]

// sections/webhooks.md, "Get a webhook" — example response of `GET /webhooks/3.json`.
// sha256(webhooks.md) = 3882fa071293971f5f913d647b5a7867645d16ec06a61abb0518b2c4863f7664
export const getWebhookExample: unknown = {
  "id": 1051369971,
  "active": true,
  "created_at": "2026-05-28T17:29:05.487Z",
  "updated_at": "2026-05-28T17:29:05.487Z",
  "payload_url": "https://example.com/endpoint",
  "types": [
    "all"
  ],
  "url": "https://3.basecampapi.com/195539477/buckets/2085958505/webhooks/1051369971.json",
  "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/webhooks/1051369971",
  "recent_deliveries": [
    {
      "id": 627138775,
      "created_at": "2026-07-21T01:05:31.186Z",
      "request": {
        "headers": {
          "Content-Type": "application/json",
          "User-Agent": "Basecamp3 Webhook",
          "X-Request-Id": "3845f9bd-2b8a-4c08-9f30-c01135ab2f23"
        },
        "body": {
          "id": 1052473966,
          "kind": "todo_completed",
          "details": {
            "notified_recipient_ids": []
          },
          "created_at": "2026-07-20T20:05:29.832-05:00",
          "recording": {
            "id": 1069480405,
            "status": "active",
            "visible_to_clients": false,
            "created_at": "2026-07-20T20:05:28.858-05:00",
            "updated_at": "2026-07-20T20:05:29.822-05:00",
            "title": "Confirm the launch-party caterer",
            "inherits_status": true,
            "type": "Todo",
            "url": "https://3.basecampapi.com/195539477/buckets/2085958505/todos/1069480405.json",
            "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/todos/1069480405",
            "bookmark_url": "https://3.basecampapi.com/195539477/my/bookmarks/BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiLmdpZDovL2JjMy9SZWNvcmRpbmcvMTA2OTQ4MDQwNT9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg1yZWFkYWJsZQY7AFQ=--1bd5883b4c5a15564fbe2c41278cb646dddead47.json",
            "subscription_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069480405/subscription.json",
            "parent": {
              "id": 1069479863,
              "title": "Background and research",
              "type": "Todolist",
              "url": "https://3.basecampapi.com/195539477/buckets/2085958505/todolists/1069479863.json",
              "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/todolists/1069479863"
            },
            "bucket": {
              "id": 2085958505,
              "name": "The Leto Laptop",
              "type": "Project"
            },
            "creator": {
              "id": 1049715913,
              "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkxMz9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--e627c45e6b34e08862da23906862412620e4d5d9",
              "name": "Victor Cooper",
              "personable_type": "User",
              "title": "Chief Strategist",
              "tagline": "Don't let your dreams be dreams",
              "location": "Chicago, IL",
              "created_at": "2026-05-28T12:22:22.069-05:00",
              "updated_at": "2026-07-20T19:05:55.167-05:00",
              "email_address": "victor@honchodesign.com",
              "bio": "Don't let your dreams be dreams",
              "admin": true,
              "owner": true,
              "client": false,
              "employee": true,
              "time_zone": "America/Chicago",
              "avatar_url": "https://bc3-production-assets-cdn.basecamp-static.com/195539477/people/BAhpBMlkkT4=--5fe7b70fbee7a7f0e2e1e19df7579e5d880c753d/avatar",
              "company": {
                "id": 1033447817,
                "name": "Honcho Design"
              },
              "can_ping": true,
              "can_manage_projects": true,
              "can_manage_people": true,
              "can_access_timesheet": true,
              "can_access_hill_charts": true
            },
            "content": "Confirm the launch-party caterer"
          },
          "creator": {
            "id": 1049715913,
            "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkxMz9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--e627c45e6b34e08862da23906862412620e4d5d9",
            "name": "Victor Cooper",
            "personable_type": "User",
            "title": "Chief Strategist",
            "tagline": "Don't let your dreams be dreams",
            "location": "Chicago, IL",
            "created_at": "2026-05-28T12:22:22.069-05:00",
            "updated_at": "2026-07-20T19:05:55.167-05:00",
            "email_address": "victor@honchodesign.com",
            "bio": "Don't let your dreams be dreams",
            "admin": true,
            "owner": true,
            "client": false,
            "employee": true,
            "time_zone": "America/Chicago",
            "avatar_url": "https://bc3-production-assets-cdn.basecamp-static.com/195539477/people/BAhpBMlkkT4=--5fe7b70fbee7a7f0e2e1e19df7579e5d880c753d/avatar",
            "company": {
              "id": 1033447817,
              "name": "Honcho Design"
            },
            "can_ping": true,
            "can_manage_projects": true,
            "can_manage_people": true,
            "can_access_timesheet": true,
            "can_access_hill_charts": true
          }
        }
      },
      "response": {
        "headers": {
          "Content-Type": "application/json"
        },
        "code": 200,
        "message": "OK",
        "body": "{}"
      }
    }
  ]
}

// sections/comments.md, "Get comments" — example response of `GET /recordings/3/comments.json`.
// sha256(comments.md) = f3c373fdc4d6309536fb600acb35d5c532ebe58c88f80f13877b812f31a4998d
export const listCommentsExample: unknown = [
  {
    "id": 1069479843,
    "status": "active",
    "visible_to_clients": false,
    "created_at": "2026-04-14T21:24:00.000Z",
    "updated_at": "2026-04-14T21:24:00.000Z",
    "title": "Re: We won Leto!",
    "inherits_status": true,
    "type": "Comment",
    "url": "https://3.basecampapi.com/195539477/buckets/2085958505/comments/1069479843.json",
    "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/messages/1069479842#__recording_1069479843",
    "bookmark_url": "https://3.basecampapi.com/195539477/my/bookmarks/BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiLmdpZDovL2JjMy9SZWNvcmRpbmcvMTA2OTQ3OTg0Mz9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg1yZWFkYWJsZQY7AFQ=--9f3559acc7461447eef3e63c725cbaf42f909e88.json",
    "boosts_count": 0,
    "boosts_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069479843/boosts.json",
    "parent": {
      "id": 1069479842,
      "title": "We won Leto!",
      "type": "Message",
      "url": "https://3.basecampapi.com/195539477/buckets/2085958505/messages/1069479842.json",
      "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/messages/1069479842"
    },
    "bucket": {
      "id": 2085958505,
      "name": "The Leto Laptop",
      "type": "Project"
    },
    "creator": {
      "id": 1049715916,
      "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkxNj9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--6414c77c0a206bc7d45987b8335318b768e8651f",
      "name": "Andrew Wong",
      "personable_type": "User",
      "title": "Senior Branding Strategist",
      "tagline": null,
      "location": null,
      "created_at": "2026-05-28T17:22:23.572Z",
      "updated_at": "2026-05-28T17:22:23.572Z",
      "email_address": "andrew@honchodesign.com",
      "bio": null,
      "admin": false,
      "owner": false,
      "client": false,
      "employee": false,
      "time_zone": "America/Chicago",
      "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBMxkkT4=--0ea74d7e5d39ad2d120da79250b179b7e0b00c44/avatar",
      "can_ping": true,
      "can_manage_projects": true,
      "can_manage_people": true,
      "can_access_timesheet": true,
      "can_access_hill_charts": true
    },
    "content": "Yeah! Great job everyone! Super excited to get going!",
    "content_attachments": []
  }
]

// sections/comments.md, "Get a comment" — example response of `GET /comments/2.json`.
// sha256(comments.md) = f3c373fdc4d6309536fb600acb35d5c532ebe58c88f80f13877b812f31a4998d
export const getCommentExample: unknown = {
  "id": 1069479852,
  "status": "active",
  "visible_to_clients": false,
  "created_at": "2026-04-15T01:18:00.000Z",
  "updated_at": "2026-04-15T01:18:00.000Z",
  "title": "Re: We won Leto!",
  "inherits_status": true,
  "type": "Comment",
  "url": "https://3.basecampapi.com/195539477/buckets/2085958505/comments/1069479852.json",
  "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/messages/1069479842#__recording_1069479852",
  "bookmark_url": "https://3.basecampapi.com/195539477/my/bookmarks/BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiLmdpZDovL2JjMy9SZWNvcmRpbmcvMTA2OTQ3OTg1Mj9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg1yZWFkYWJsZQY7AFQ=--94ecf8956b99a44c68d14588fb31b3b3439d70a4.json",
  "boosts_count": 0,
  "boosts_url": "https://3.basecampapi.com/195539477/buckets/2085958505/recordings/1069479852/boosts.json",
  "parent": {
    "id": 1069479842,
    "title": "We won Leto!",
    "type": "Message",
    "url": "https://3.basecampapi.com/195539477/buckets/2085958505/messages/1069479842.json",
    "app_url": "https://3.basecamp.com/195539477/buckets/2085958505/messages/1069479842"
  },
  "bucket": {
    "id": 2085958505,
    "name": "The Leto Laptop",
    "type": "Project"
  },
  "creator": {
    "id": 1049715938,
    "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiK2dpZDovL2JjMy9QZXJzb24vMTA0OTcxNTkzOD9leHBpcmVzX2luBjsAVEkiCHB1cgY7AFRJIg9hdHRhY2hhYmxlBjsAVA==--4ccc567a0a3b10e354bca909b704637b601f0b16",
    "name": "Annie Bryan",
    "personable_type": "User",
    "title": "Central Markets Manager",
    "tagline": "To open a store is easy, to keep it open is an art",
    "location": null,
    "created_at": "2026-05-28T17:22:29.167Z",
    "updated_at": "2026-05-28T17:22:29.167Z",
    "email_address": "annie@honchodesign.com",
    "bio": "To open a store is easy, to keep it open is an art",
    "admin": false,
    "owner": false,
    "client": false,
    "employee": true,
    "time_zone": "America/Chicago",
    "avatar_url": "https://3.basecampapi.com/195539477/people/BAhpBOJkkT4=--732a71fbd28ec10d9bf4466abd3588a8bea40bdb/avatar",
    "company": {
      "id": 1033447817,
      "name": "Honcho Design"
    },
    "can_ping": true,
    "can_manage_projects": true,
    "can_manage_people": true,
    "can_access_timesheet": true,
    "can_access_hill_charts": true
  },
  "content": "I just want to echo what just about everyone already said. This is a big one for us, and I can't wait to get going. I'll be spinning up the project shortly!",
  "content_attachments": []
}

// sections/attachments.md, "Create an attachment" — example response of `POST /attachments.json`.
// sha256(attachments.md) = 7ec8f172fab0034572071f67c1c16d9ad058c81cdeddfd9386fadedff8d0d5fd
export const createAttachmentExample: unknown = {
  "id": 1046628513,
  "attachable_sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiL2dpZDovL2JjMy9BdHRhY2htZW50LzEwNDY2Mjg1MTM_ZXhwaXJlc19pbgY7AFRJIghwdXIGOwBUSSIPYXR0YWNoYWJsZQY7AFQ=--f4fec6f98ff48e45ceb144416a3a68234452a864",
  "sgid": "BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiL2dpZDovL2JjMy9BdHRhY2htZW50LzEwNDY2Mjg1MTM_ZXhwaXJlc19pbgY7AFRJIghwdXIGOwBUSSIPYXR0YWNoYWJsZQY7AFQ=--f4fec6f98ff48e45ceb144416a3a68234452a864",
  "status_url": "https://upload.3.basecamp.com/195539477/attachments/BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiL2dpZDovL2JjMy9BdHRhY2htZW50LzEwNDY2Mjg1MTM_ZXhwaXJlc19pbgY7AFRJIghwdXIGOwBUSSIPYXR0YWNoYWJsZQY7AFQ=--f4fec6f98ff48e45ceb144416a3a68234452a864.json",
  "caption": null,
  "byte_size": 1281,
  "content_type": "image/png",
  "width": 164,
  "height": 39,
  "key": "f628dbcc65dd018a72ae025824ffa8fb4fe3ecf8",
  "filename": "company-logo.png",
  "download_url": "https://storage.3.basecamp.com/195539477/blobs/f628dbcc65dd018a72ae025824ffa8fb4fe3ecf8/download/company-logo.png",
  "previewable": true,
  "preview_url": "https://preview.3.basecamp.com/195539477/blobs/f628dbcc65dd018a72ae025824ffa8fb4fe3ecf8/previews/full",
  "thumbnail_url": "https://preview.3.basecamp.com/195539477/blobs/f628dbcc65dd018a72ae025824ffa8fb4fe3ecf8/previews/card"
}
