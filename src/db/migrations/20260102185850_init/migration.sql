-- CreateTable
CREATE TABLE "GooglePlaceUrlToScrape" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" BOOLEAN,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GooglePlaceUrlToScrape_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GooglePlaceUrlToScrape_url_key" ON "GooglePlaceUrlToScrape"("url");
