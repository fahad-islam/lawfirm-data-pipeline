# Law Firm Data Pipeline

A TypeScript-based background worker system that extracts law firm information from Google Search Places and syncs it to Giighire CRM.

## 🚀 Overview

This project automates the discovery and collection of law firm data from Google Places, extracting comprehensive firm information and storing it in Giighire CRM for business development and lead generation.

## ✨ Features

- 🔍 **Google Places Scraping**: Extracts law firm listings from Google Search Places tab
- 📊 **Comprehensive Data Extraction**: Collects detailed firm information including:
  - Firm name and address
  - Contact information (phone, website, email)
  - Business hours and ratings
  - Reviews and client feedback
  - Practice areas and specializations
  - Additional metadata
- 💾 **CRM Integration**: Automatic synchronization with Giighire CRM
- ⚙️ **Background Workers**: Async processing using workflows
- 🔄 **Retry Logic**: Handles failures gracefully with automatic retries
- 📝 **Database**: Prisma ORM for data management
- 🏃 **Fast Runtime**: Built with Bun for superior performance

## 🛠️ Tech Stack

- **Runtime**: [Bun](https://bun.sh) - Fast all-in-one JavaScript runtime
- **Language**: TypeScript
- **ORM**: Prisma
- **Database**: PostgreSQL (configured via Prisma)

## 📋 Prerequisites

- [Bun](https://bun.sh) v1.0.0+
- PostgreSQL database
- Giighire CRM API credentials
- Google Places API access (if applicable)

## 🚀 Installation
```bash
# Clone the repository
git clone https://github.com/fahad-islam/lawfirm-data-pipeline.git
cd lawfirm-data-pipeline

# Install dependencies
bun install

# Copy environment variables
cp ".env example" .env

# Configure your credentials in .env file
```

## ⚙️ Configuration

Create a `.env` file based on `.env example`.

## 🗄️ Database Setup
```bash
# Generate Prisma Client
bun run prisma generate

# Run database migrations
bun run prisma migrate dev

# (Optional) Seed the database
bun run prisma db seed
```

## 🎯 Usage

### Running the Worker
```bash
# Start the background worker
bun run src/runner/(locator|syncCrm|websiteScraper).ts
```

## 🛡️ Error Handling

The system includes comprehensive error handling:

- **Rate Limiting**: Automatic exponential backoff for API rate limits
- **Retry Logic**: Failed extractions retry up to 3 times with configurable delays
- **Error Logging**: All errors logged with detailed stack traces
- **Dead Letter Queue**: Failed items moved to DLQ for manual review
- **Database Transactions**: Ensures data consistency

## 📊 Monitoring
```bash
# View real-time logs
bun run logs

# Check worker status
bun run status

# View extraction statistics
bun run stats

# Prisma Studio (Database GUI)
bun run prisma studio
```

## 🐳 Docker Deployment
```bash
# Build Docker image
docker build -t lawfirm-pipeline .

# Run container
docker run -d --env-file .env lawfirm-pipeline

# Using Docker Compose (create docker-compose.yml first)
docker-compose up -d
```

## 🧪 Development
```bash
# Run tests
bun test

# Run linter
bun run lint

# Format code
bun run format

# Type checking
bun run type-check

# Database operations
bun run prisma studio    # Open Prisma Studio
bun run prisma migrate   # Run migrations
```

## 🚀 Production Deployment

### Environment Setup

1. Set `NODE_ENV=production` in your environment
2. Use production database credentials
3. Configure proper logging (e.g., CloudWatch, Datadog)
4. Set up alerting for failed jobs
5. Implement monitoring dashboards

### Recommended Infrastructure

- **Job Queue**: @effect/cluster, @effect/workflow for scalable task distribution
- **Logging**: Centralized logging with ELK stack or CloudWatch
- **Monitoring**: Prometheus + Grafana for metrics
- **Alerts**: PagerDuty or similar for critical failures

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

### Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `test:` - Adding tests
- `chore:` - Maintenance tasks

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 📧 Support

For issues, questions, or contributions:

- 🐛 [Open an issue](https://github.com/fahad-islam/lawfirm-data-pipeline/issues)
- 💬 [Start a discussion](https://github.com/fahad-islam/lawfirm-data-pipeline/discussions)
- 📧 Contact: [muhammad-fahad-islam](https://www.linkedin.com/in/muhammad-fahad-islam/)

## 🗺️ Roadmap

- [ ] Add support for additional practice area filters
- [ ] Implement real-time monitoring dashboard
- [ ] Add export to CSV/Excel functionality
- [ ] Support for multiple CRM integrations (Salesforce, HubSpot)
- [ ] Machine learning for data quality scoring
- [ ] Duplicate detection and deduplication logic
- [ ] Webhook support for real-time updates
- [ ] API endpoints for external integrations

---

**Built with ⚡ by [Fahad Islam](https://github.com/fahad-islam)**

---

### Performance Notes

Using Bun provides several advantages:
- **3x faster** package installation compared to npm
- **Built-in TypeScript** support without additional transpilation
- **Native test runner** included
- **Fast bundler** for production builds
- **Better memory efficiency** for background workers

### Troubleshooting

**Database Connection Issues**
```bash
# Test database connection
bun run prisma db pull

# Reset database (⚠️ deletes all data)
bun run prisma migrate reset
```

**Bun Installation Issues**
```bash
# Verify Bun installation
bun --version

# Reinstall Bun
curl -fsSL https://bun.sh/install | bash
```

**Worker Not Running**
- Check `.env` file configuration
- Verify database connection
- Check logs for errors: `bun run logs`