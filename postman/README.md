# Postman Collection for Console API

## Quick Start

### 1. Import Collection
- Open Postman
- Click **Import**
- Select `Console-API.postman_collection.json`

### 2. Import Environment
- Click **Environments**
- Click **Import**
- Select `Console-API.postman_environment.json`

### 3. Select Environment
- Click environment dropdown (top right)
- Select **Console API - Development**

### 4. Configure
Update these environment variables:
```
meta_waba_id: YOUR_META_WABA_ID
meta_phone_number_id: YOUR_META_PHONE_NUMBER_ID
```

### 5. Start Testing!
Run "Onboard Company" first - it will auto-populate `api_key` and `company_key`

## What's Included

- **40+ API requests** organized in 7 folders
- **Auto-populated variables** (api_key, company_key, IDs)
- **Pre-request scripts** for dynamic data
- **Test scripts** for automatic validation
- **Examples** for each request type

## Collection Structure

```
Console API
├── 1. Company Management (4 requests)
├── 2. WABA & Phone Numbers (5 requests)
├── 3. Templates (4 requests)
├── 4. Messages (6 requests)
├── 5. Webhooks (4 requests)
├── 6. Credits (3 requests)
└── 7. Health Check (1 request)
```

## Testing Flow

**Recommended order:**
1. Onboard Company → Creates account, returns keys
2. Create WABA Account → Setup WhatsApp Business Account
3. Add Phone Number → Add phone to WABA
4. Sync Templates → Get templates from Meta
5. Send Message → Test messaging
6. Check Credit Balance → Verify deduction

## Environment Variables

These are auto-populated as you test:

| Variable | Auto-Set By |
|----------|-------------|
| `api_key` | Onboard Company |
| `company_key` | Onboard Company |
| `company_id` | Onboard Company |
| `waba_id` | Create WABA |
| `phone_number_id` | Add Phone Number |
| `webhook_id` | Create Webhook |

## Features

### ✅ Auto-Authentication
Collection-level auth uses `{{api_key}}` automatically

### ✅ Variable Extraction
Test scripts extract IDs from responses:
```javascript
pm.environment.set('company_id', response.data.id);
```

### ✅ Multiple Examples
Each request includes examples for different scenarios

### ✅ Error Handling
Test scripts validate responses and show errors

## Documentation

- Full guide: [API_TESTING_GUIDE.md](../API_TESTING_GUIDE.md)
- Authentication: [AUTHENTICATION.md](../AUTHENTICATION.md)
- API Reference: [README.md](../README.md)

## Troubleshooting

**401 Unauthorized?**
- Run "Onboard Company" first
- Check environment is selected
- Verify `api_key` and `company_key` are set

**Variables not populating?**
- Check response is successful (200/201)
- Look at "Tests" tab in request
- Manually set if needed

**Need help?**
See [API_TESTING_GUIDE.md](../API_TESTING_GUIDE.md) for detailed troubleshooting

## Export to cURL

1. Click any request
2. Click **</>** (Code snippet)
3. Select cURL
4. Copy command

## Share Collection

**Via Link:**
1. Click collection menu (...)
2. Share collection
3. Get public link

**Via File:**
Send `Console-API.postman_collection.json` to team members

---

**Happy Testing! 🚀**
