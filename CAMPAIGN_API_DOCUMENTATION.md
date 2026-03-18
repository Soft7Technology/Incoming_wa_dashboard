# Campaign Management API Documentation

## Overview

This is a comprehensive WhatsApp campaign management system with advanced contact management, XLSX import, template mapping, scheduling, and message tracking.

### Key Features

✅ **Centralized Contact Management** - Store contacts once, use in multiple campaigns
✅ **Tag-based Segmentation** - Organize contacts with tags for targeted campaigns
✅ **XLSX Import** - Upload contact lists with dynamic attribute detection
✅ **Smart Campaign Scheduling** - Schedule campaigns or send immediately (with 5-min delay)
✅ **Template Parameter Mapping** - Map contact attributes to template variables
✅ **Media Upload Support** - Upload images, videos, documents for templates
✅ **Message Tracking** - Track sent, delivered, read, and failed messages
✅ **Invalid Number Detection** - Auto-detect and track WhatsApp-invalid numbers
✅ **Test Campaign** - Test templates before launching campaigns
✅ **Real-time Statistics** - Track campaign performance in real-time

---

## Installation

### 1. Install Required Dependencies

```bash
npm install xlsx multer @types/multer node-cron @types/node-cron
```

### 2. Run Database Migrations

```bash
npm run migrate:latest
```

This will create the following tables:
- `contacts` - Main contact storage
- `contact_tags` - Tag definitions
- `contact_tag_relations` - Many-to-many contact-tag relationships
- `contact_lists` - XLSX upload lists
- `contact_list_relations` - Many-to-many contact-list relationships
- `campaign_messages` - Campaign message tracking
- Updates to `campaigns` table for filter-based targeting

### 3. Create Upload Directories

```bash
mkdir -p uploads/temp uploads/contacts uploads/media
```

---

## API Endpoints

### Contact Management

#### Create Contact
```http
POST /v1/contacts
Authorization: X-API-Key, X-Company-Key
Content-Type: application/json

{
  "phone_number": "+1234567890",
  "name": "John Doe",
  "email": "john@example.com",
  "attributes": {
    "company": "Acme Inc",
    "position": "Manager",
    "city": "New York"
  },
  "notes": "VIP customer",
  "tag_ids": ["tag-uuid-1", "tag-uuid-2"]
}
```

#### Get All Contacts
```http
GET /v1/contacts?page=1&limit=20&is_valid=true&search=john&tag_ids=tag1,tag2&list_ids=list1
Authorization: X-API-Key, X-Company-Key
```

**Query Parameters:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20)
- `is_valid` - Filter by validity (true/false)
- `search` - Search in name, phone, email
- `tag_ids` - Filter by tags (comma-separated)
- `list_ids` - Filter by lists (comma-separated)

#### Get Contact by ID
```http
GET /v1/contacts/:id
Authorization: X-API-Key, X-Company-Key
```

#### Update Contact
```http
PUT /v1/contacts/:id
Authorization: X-API-Key, X-Company-Key
Content-Type: application/json

{
  "name": "John Updated",
  "attributes": {
    "position": "Senior Manager"
  },
  "tag_ids": ["new-tag-id"]
}
```

#### Delete Contact
```http
DELETE /v1/contacts/:id
Authorization: X-API-Key, X-Company-Key
```

---

### XLSX Import

#### Preview XLSX File
```http
POST /v1/contacts/import/preview
Authorization: X-API-Key, X-Company-Key
Content-Type: multipart/form-data

file: <xlsx_file>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "headers": ["phone", "name", "email", "company", "position"],
    "preview": [
      { "phone": "+1234567890", "name": "John Doe", "email": "john@example.com" }
    ],
    "total_rows": 150,
    "detected_phone_column": "phone"
  }
}
```

#### Import Contacts from XLSX
```http
POST /v1/contacts/import
Authorization: X-API-Key, X-Company-Key
Content-Type: multipart/form-data

file: <xlsx_file>
list_name: "Q4 Customers"
phone_column: "phone"              # Optional - auto-detected
name_column: "name"                # Optional
email_column: "email"              # Optional
tag_ids: "tag1,tag2"               # Optional - apply tags to imported contacts
```

**Response:**
```json
{
  "success": true,
  "data": {
    "list": { "id": "list-uuid", "name": "Q4 Customers" },
    "imported": 145,
    "skipped": 5,
    "errors": [
      { "row": 10, "error": "Invalid phone format" }
    ]
  }
}
```

**Supported File Formats:** `.xlsx`, `.xls`

**Phone Number Auto-Detection:** Automatically detects columns named:
- `phone`, `phone_number`, `mobile`, `whatsapp`, `contact`, `number`, `cell`, `telephone`

**Phone Number Format:** Automatically normalizes to international format (+[country][number])

---

### Tag Management

#### Create Tag
```http
POST /v1/contacts/tags
Authorization: X-API-Key, X-Company-Key
Content-Type: application/json

{
  "name": "VIP Customers",
  "color": "#FF5733",
  "description": "High-value customers"
}
```

#### Get All Tags
```http
GET /v1/contacts/tags
Authorization: X-API-Key, X-Company-Key
```

#### Update Tag
```http
PUT /v1/contacts/tags/:id
Authorization: X-API-Key, X-Company-Key
Content-Type: application/json

{
  "name": "Premium Customers",
  "color": "#00FF00"
}
```

#### Delete Tag
```http
DELETE /v1/contacts/tags/:id
Authorization: X-API-Key, X-Company-Key
```

#### Add Tags to Contact
```http
POST /v1/contacts/:id/tags
Authorization: X-API-Key, X-Company-Key
Content-Type: application/json

{
  "tag_ids": ["tag-uuid-1", "tag-uuid-2"]
}
```

#### Remove Tags from Contact
```http
DELETE /v1/contacts/:id/tags
Authorization: X-API-Key, X-Company-Key
Content-Type: application/json

{
  "tag_ids": ["tag-uuid-1"]
}
```

---

### List Management

#### Get All Lists
```http
GET /v1/contacts/lists
Authorization: X-API-Key, X-Company-Key
```

#### Get List by ID
```http
GET /v1/contacts/lists/:id
Authorization: X-API-Key, X-Company-Key
```

#### Get Contacts in List
```http
GET /v1/contacts/lists/:id/contacts?page=1&limit=20&is_valid=true
Authorization: X-API-Key, X-Company-Key
```

#### Delete List
```http
DELETE /v1/contacts/lists/:id
Authorization: X-API-Key, X-Company-Key
```

---

## Campaign Management

### Create Campaign
```http
POST /v1/campaigns
Authorization: X-API-Key, X-Company-Key
Content-Type: application/json

{
  "name": "Black Friday Sale",
  "description": "Promotional campaign for Black Friday",
  "phone_number_id": "phone-uuid",
  "template_id": "template-uuid",
  "contact_filters": {
    "tag_ids": ["vip-tag", "active-tag"],
    "list_ids": ["list-uuid"],
    "exclude_invalid": true,
    "attributes": {
      "city": "New York"
    }
  },
  "parameter_mapping": {
    "1": "name",
    "2": "company",
    "3": "custom_attribute"
  },
  "media_uploads": [
    {
      "type": "image",
      "media_id": "meta-media-id"
    }
  ],
  "scheduled_at": "now"  // or ISO date "2025-12-20T10:00:00Z"
}
```

**Contact Filters:**
- `tag_ids` - Array of tag UUIDs (OR condition)
- `list_ids` - Array of list UUIDs (OR condition)
- `exclude_invalid` - Exclude invalid WhatsApp numbers (default: true)
- `attributes` - Filter by custom attributes (AND condition)

**Parameter Mapping:**
- Key: Template parameter position (1, 2, 3...)
- Value: Contact attribute name (`name`, `email`, `phone_number`, or any custom attribute)

**Scheduled At:**
- `"now"` - Schedule 5 minutes from now
- ISO Date - Schedule for specific time
- Omit - Save as draft

### Get All Campaigns
```http
GET /v1/campaigns?page=1&limit=20&status=running&phone_number_id=phone-uuid&search=black
Authorization: X-API-Key, X-Company-Key
```

**Query Parameters:**
- `status` - Filter by status (`draft`, `scheduled`, `running`, `paused`, `completed`, `failed`)
- `phone_number_id` - Filter by phone number
- `search` - Search in name/description
- `page`, `limit` - Pagination

### Get Campaign by ID
```http
GET /v1/campaigns/:id
Authorization: X-API-Key, X-Company-Key
```

**Response includes:**
- Campaign details
- Real-time statistics
- Template information
- Contact filters

### Start Campaign
```http
POST /v1/campaigns/:id/start
Authorization: X-API-Key, X-Company-Key
```

Starts campaign execution immediately. Campaign status changes to `running`.

### Pause Campaign
```http
POST /v1/campaigns/:id/pause
Authorization: X-API-Key, X-Company-Key
```

Pauses a running campaign. Can be resumed later.

### Resume Campaign
```http
POST /v1/campaigns/:id/resume
Authorization: X-API-Key, X-Company-Key
```

Resumes a paused campaign.

### Test Campaign
```http
POST /v1/campaigns/:id/test
Authorization: X-API-Key, X-Company-Key
Content-Type: application/json

{
  "test_phone_number": "+1234567890"
}
```

Sends a test message to verify template and parameter mapping before launching the campaign.

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Test message sent successfully",
    "message_id": "message-uuid",
    "variables": {
      "1": "Test User",
      "2": "Test Company"
    },
    "template": { ... }
  }
}
```

### Get Campaign Statistics
```http
GET /v1/campaigns/:id/stats
Authorization: X-API-Key, X-Company-Key
```

**Response:**
```json
{
  "success": true,
  "data": {
    "campaign_id": "campaign-uuid",
    "name": "Black Friday Sale",
    "status": "running",
    "total_recipients": 1000,
    "sent_count": 750,
    "delivered_count": 700,
    "read_count": 450,
    "failed_count": 50,
    "invalid_numbers_count": 25,
    "total_cost": 37.50,
    "scheduled_at": "2025-12-15T10:00:00Z",
    "started_at": "2025-12-15T10:00:05Z",
    "completed_at": null,
    "detailed_stats": {
      "pending": 225,
      "sent": 750,
      "delivered": 700,
      "read": 450,
      "failed": 50,
      "skipped": 25
    }
  }
}
```

### Delete Campaign
```http
DELETE /v1/campaigns/:id
Authorization: X-API-Key, X-Company-Key
```

**Note:** Cannot delete running campaigns. Pause first.

### Upload Media for Campaign
```http
POST /v1/campaigns/upload-media
Authorization: X-API-Key, X-Company-Key
Content-Type: multipart/form-data

phone_number_id: "phone-uuid"
type: "image"  // or "video", "document", "audio"
file: <media_file>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "media_id": "meta-media-id-123",
    "type": "image"
  }
}
```

Use the returned `media_id` in campaign creation's `media_uploads` array.

---

## How It Works

### Contact Management Flow

1. **Import Contacts** - Upload XLSX file with contact data
2. **Auto-Detection** - System detects phone column and normalizes numbers
3. **Create List** - Contacts are organized into a list
4. **Apply Tags** - Optionally tag imported contacts
5. **Deduplication** - Existing contacts are updated, not duplicated
6. **Attributes Stored** - All XLSX columns stored as flexible attributes

### Campaign Execution Flow

1. **Create Campaign** - Define template, filters, and parameter mapping
2. **Filter Contacts** - System selects contacts based on tags/lists/attributes
3. **Schedule** - Set immediate (5-min delay) or specific time
4. **Auto-Start** - Scheduler automatically starts campaigns at scheduled time
5. **Batch Processing** - Sends messages in batches to avoid rate limiting
6. **Track Status** - Real-time tracking of message delivery status
7. **Invalid Detection** - Automatically marks invalid WhatsApp numbers
8. **Update Contacts** - Contact stats updated (message_count, failed_count)

### Invalid Number Detection

The system automatically detects invalid WhatsApp numbers through webhook responses:

**Detection Triggers:**
- Meta error code 1013 (Number not on WhatsApp)
- Meta error code 131051 (Unsupported recipient)
- Meta error code 131026/131047 (Blocked/Rate limited)

**Actions Taken:**
1. Mark contact as invalid (`is_valid = false`)
2. Record reason (`not_whatsapp`, `invalid_format`, `blocked`)
3. Skip contact in future campaigns (if `exclude_invalid = true`)
4. Update campaign's `invalid_numbers_count`
5. Provide suggestion to user about invalid numbers

**Benefits:**
- Save credits by not sending to invalid numbers
- Clean contact database over time
- Better campaign ROI

---

## Template Parameter Mapping

### Example Template (Meta Format)
```
Hello {{1}},

Your order #{{2}} from {{3}} is ready for pickup!

Thank you for shopping with us.
```

### Parameter Mapping in Campaign
```json
{
  "parameter_mapping": {
    "1": "name",
    "2": "order_id",
    "3": "company"
  }
}
```

### Contact Attributes
```json
{
  "name": "John Doe",
  "phone_number": "+1234567890",
  "attributes": {
    "order_id": "ORD-12345",
    "company": "Acme Store"
  }
}
```

### Resolved Message
```
Hello John Doe,

Your order #ORD-12345 from Acme Store is ready for pickup!

Thank you for shopping with us.
```

---

## Campaign Scheduler

The system includes an automatic scheduler that:

- Runs every minute via cron job
- Checks for campaigns with `status = 'scheduled'` and `scheduled_at <= now()`
- Automatically starts eligible campaigns
- Handles failures gracefully

**Manual Operations:**
- Start campaign immediately via `POST /v1/campaigns/:id/start`
- Pause/Resume campaigns anytime
- Scheduler respects manual pauses

---

## Message Tracking

### Campaign Message States

1. **pending** - Waiting to be sent
2. **sent** - Sent to WhatsApp API
3. **delivered** - Delivered to recipient
4. **read** - Read by recipient
5. **failed** - Failed to send
6. **skipped** - Skipped (invalid number, etc.)

### Webhook Integration

The system integrates with Meta webhooks to:
- Update message statuses in real-time
- Detect invalid numbers automatically
- Update campaign statistics
- Trigger custom webhooks for clients

---

## Best Practices

### Contact Import
- ✅ Use international phone format (+[country][number])
- ✅ Include name and email for better personalization
- ✅ Add custom attributes for advanced segmentation
- ✅ Use tags to organize contacts logically
- ✅ Preview file before import to verify columns

### Campaign Creation
- ✅ Test template with test API before launching
- ✅ Use `exclude_invalid = true` to save credits
- ✅ Map all template parameters correctly
- ✅ Schedule campaigns during business hours
- ✅ Monitor statistics during execution

### Template Design
- ✅ Keep messages concise and clear
- ✅ Use approved templates only
- ✅ Personalize with contact attributes
- ✅ Include media when appropriate
- ✅ Follow WhatsApp Business Policy

---

## Error Handling

### Common Errors

**Invalid XLSX File:**
```json
{
  "success": false,
  "message": "Invalid XLSX file: Could not detect phone number column"
}
```
**Solution:** Ensure XLSX has a column named "phone", "mobile", or similar.

**No Contacts Match Filters:**
```json
{
  "success": false,
  "message": "No contacts found matching the specified filters"
}
```
**Solution:** Adjust contact_filters or import contacts first.

**Template Not Approved:**
```json
{
  "success": false,
  "message": "Template must be approved before use in campaigns"
}
```
**Solution:** Wait for Meta to approve template or use an approved one.

---

## Performance Considerations

### Batch Processing
- Messages sent in batches of 10 with 2-second delays
- Prevents API rate limiting
- Adjustable in `campaign.service.ts`

### Database Indexing
- All tables have proper indexes for fast queries
- Contact filtering is optimized for large datasets
- Use pagination for contact lists

### File Storage
- XLSX files stored in `uploads/contacts/{company_id}/`
- Media files stored in `uploads/media/{company_id}/`
- Clean up old files periodically

---

## Security

### File Validation
- Only XLSX/XLS files accepted for contact import
- Only approved media types for templates
- File size limits enforced (10MB XLSX, 50MB media)
- Malicious file detection via MIME type validation

### Authentication
- All endpoints require X-API-Key and X-Company-Key
- Company isolation enforced in all queries
- No cross-company data access

---

## Support & Troubleshooting

### Logs
Check application logs for:
- Campaign execution errors
- XLSX parsing issues
- Invalid number detections
- Webhook processing

### Database Queries
```sql
-- Check campaign progress
SELECT id, name, status, sent_count, total_recipients
FROM campaigns WHERE status = 'running';

-- Find invalid contacts
SELECT phone_number, invalid_reason, last_invalid_at
FROM contacts WHERE is_valid = false;

-- Campaign message breakdown
SELECT status, COUNT(*)
FROM campaign_messages
WHERE campaign_id = 'campaign-uuid'
GROUP BY status;
```

---

## Roadmap

Future enhancements:
- [ ] A/B testing campaigns
- [ ] Scheduled recurring campaigns
- [ ] Advanced analytics dashboard
- [ ] Contact scoring/engagement tracking
- [ ] Custom workflow automation
- [ ] Multi-template campaigns
- [ ] Contact deduplication across lists

---

## License

Proprietary - Surefy Platform
