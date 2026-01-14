import { Activity } from "@effect/workflow"
import { Config, Duration, Effect, Schema } from "effect"
import { PlaceWebsiteScraperWorkflow as Workflow } from "../workflow.ts"
import { z } from "zod"
import { PrismaService } from "@/db/client/effect.ts"
import { BrowserAgentService } from "@/services/browser.ts"

export class ScrapeWebsiteError extends Schema.TaggedError<ScrapeWebsiteError>(
    "ScrapeWebsiteError"
)("ScrapeWebsiteError", {
    message: Schema.String,
    metaData: Schema.optionalWith(Schema.Any, { exact: true })
}) { }

const errorHandler = {
    catch: (error: unknown) => new ScrapeWebsiteError({
        message: (error as Error).message,
        metaData: JSON.stringify(error)
    })
}

const LegalTags = [
    "Aviation Law",
    "Banking & Finance",
    "Civil Law",
    "Commercial",
    "Contract Law",
    "Corporate Crime",
    "Criminal",
    "Data Protection & GDPR",
    "Employment",
    "Employment Law – For Employees",
    "Employment Law – For Employers",
    "Energy & Natural Resources",
    "Environmental & Climate Change Law",
    "Extradition",
    "Franchising",
    "Infrastructure & Projects",
    "Intellectual Property",
    "International Law",
    "Jurisdiction & Recognition of Judgments",
    "Media & Entertainment Law",
    "Miscarriage of Justice",
    "Oil/Gas & Renewables",
    "Pensions Law",
    "Property Law",
    "Regulatory Law",
    "Restrucuring & Insolvency",
    "Road Traffic Offences",
    "Shipping/Maritime Law",
    "Sports Law",
    "White Collar Crime",
    "Arbitration & Alternative Dispute Resolution (ADR)",
    "Bad Commercial Loans",
    "Civil Litigation",
    "Commercial Contracts",
    "Commercial Litigation",
    "Community Infrastructure Levy",
    "Compulsory Purchase",
    "Construction Disputes",
    "Consumer Law",
    "Corporate",
    "Corporate Governance",
    "Debt Recovery",
    "Defamation",
    "Exit Strategy Legal Planning",
    "Financial Claims Management",
    "Fraud & Scam Recovery",
    "Highways & Transport Law",
    "Human Rights",
    "Injunctions",
    "Insurance Litigation",
    "International Legal Services",
    "IP Litigation",
    "Mergers & Acquisitions",
    "Mis-Sold Car Finance",
    "Mis-Sold Investments",
    "Mis-Sold Overseas Property Investments",
    "Mis-Sold Pensions",
    "Mis-Sold SIPPs",
    "Notarial Law",
    "Planning Appeals",
    "Planning Applications & Objections",
    "Planning Enforcement",
    "Planning Law",
    "Professional Negligence",
    "Property Litigation",
    "Section 106 Agreements",
    "Small Claims",
    "Sworn Translation",
    "Virtual Legal Counsel",
    "Accident at Work",
    "Asbestos Disease",
    "Asylum Appeals",
    "Childcare and Custody",
    "Citizenship and Naturalization",
    "Commercial Property",
    "Construction Non Contentious",
    "Conveyancing",
    "Corporate Dispute Resolution",
    "Corporate Immigration",
    "Court of Protection",
    "Deportation Defense",
    "Dispute Resolution",
    "Dissolution Advisory",
    "Employment Disputes",
    "Employment Rights",
    "Housing Disrepair",
    "Industrial Disease",
    "Landlord and Tenant",
    "NDA Drafting",
    "Partnership Disputes",
    "Property Development",
    "Real Estate Finance",
    "Serious Injury",
    "Settlement Agreements",
    "SMEs Legal Support",
    "Startups Advisory",
    "Welfare Benefits",
    "Care Proceedings",
    "Charity Law",
    "Children Law",
    "Clinical Negligence",
    "Cohabitation Agreements",
    "Contentious Child Issues",
    "Contentious Probate",
    "Contested Probate & Trusts",
    "Divorce & Separation",
    "Divorce and Dissolution",
    "EL/PL",
    "Estate Planning",
    "Family Law",
    "Immigration",
    "Lasting Powers of Attorney (LPA)",
    "Legal Aid Family",
    "Litigation",
    "Mediation",
    "Medical Negligence",
    "Non-molestation Order",
    "Notary Public",
    "Parental Abduction",
    "Personal Injury",
    "Prenuptial Agreements",
    "Private Client",
    "Public Law",
    "RTA Road Traffic Accidents",
    "Serious/Catastrophic Injury",
    "Trusts",
    "Wills"
] as const

const LegalTagEnums = z.enum(LegalTags)

export const scrapeWebsite = (
    { payload, executionId }: { payload: typeof Workflow.payloadSchema.Type, executionId: string }
) => {
    return Activity.make({
        name: "ScrapeWebsite",
        error: ScrapeWebsiteError,
        execute: Effect.gen(function* () {
            const attempt = yield* Activity.CurrentAttempt

            const db = yield* PrismaService


            const { url } = payload

            yield* Effect.log({
                payload
            })

            // Start browser agent
            const browserAgentService = yield* BrowserAgentService;

            const agent = yield* browserAgentService.getBrowserAgent()

            // Navigate to URL
            yield* Effect.tryPromise({
                try: () => agent.page.goto(url, { timeout: 150000 }),
                ...errorHandler,
            })

            const extractedData = yield* Effect.tryPromise({
                try: () => agent.extract("Extract company information and services", z.object({
                    emailAddress: z.string().optional(),
                    telephoneNumber: z.string().optional().default(payload.phone!),
                    address: z.string().optional().default(payload.address!).describe("template Building Number Street, City, Postal code, Country"),
                    servicesOffered: z.array(LegalTagEnums).describe(`Only pick tags from the provided enums from ${JSON.stringify(LegalTags)}. Make sure to cover all of the services under these tags.`),
                    // newTagsFound: z.array(z.string()).max(20).describe("Any legal service found not in the list of servicesOffered as tags max 20. Make sure you pick the uncovered service not some random stuff")
                })),
                ...errorHandler,
            }).pipe(
                Effect.timeout(Duration.minutes(3))
            )

            yield* Effect.tryPromise({
                try: () => agent.page.waitForTimeout(10000),
                ...errorHandler,
            })

            // Stop browser agent
            yield* Effect.tryPromise({
                try: () => agent.stop(),
                ...errorHandler,
            })

            yield* Effect.log({
                extractedData
            })

            if (extractedData.servicesOffered.length === 0 || extractedData.telephoneNumber.includes("+1")) {
                return;
            }

            yield* db.company.create({
                data: {
                    name: payload.name ?? "Default Name",
                    websiteUrl: payload.url,
                    emailAddress: extractedData.emailAddress ?? null,
                    phoneNumber: extractedData.telephoneNumber ?? null,
                    address: extractedData.address ?? null,
                    industry: "Legal", // or ?? null
                    location: payload.location,
                    servicesOffered: {
                        ...(extractedData.servicesOffered.length ?
                            {
                                connectOrCreate: [...new Set(extractedData.servicesOffered)].map((tagName) => ({
                                    create: {
                                        name: tagName
                                    },
                                    where: {
                                        name: tagName
                                    }
                                }))
                            } : {})
                    }
                }
            }).pipe(
                Effect.mapError(errorHandler.catch),
                Effect.tapError((error) => Effect.logError(error.metaData)),
            )

            // Log the extraction with the data
            yield* Effect.annotateLogs(
                Effect.logInfo("Scrape website completed successfully"),
                {
                    id: payload.id,
                    executionId,
                    attempt,
                    url,
                    extractedData
                }
            )

            return extractedData
        }).pipe(
            Effect.scoped,
            Effect.mapError(errorHandler.catch)
        )
    }).pipe(
        Activity.retry({ times: 1, }),
        Workflow.withCompensation(
            Effect.fn(function* (value, cause) {
                yield* Effect.logWarning("Compensating activity ScrapeWebsite")
                yield* Effect.logDebug(`Compensation value: ${JSON.stringify(value)}`)
                yield* Effect.logDebug(`Compensation cause: ${cause}`)
            })
        )
    )
}