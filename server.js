import express from 'express';
import { fork } from 'child_process';
import { chromium } from 'playwright';
import dotenv from 'dotenv';
dotenv.config();

const app = express();

// =============================
// CRAWLER CODE GỐC CỦA BẠN
// =============================
const BASE_URL = 'https://www.writerworking.net';
const MAX_BOOK_TABS = 24;
const MAX_CHAPTER_TABS = 20;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function crawlChapterContent(context, chapterUrl) {
    const page = await context.newPage();
    await page.route('**/*', route => {
        const type = route.request().resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(type)) route.abort();
        else route.continue();
    });

    let content = '';
    let title = '';

    try {
        await page.goto(chapterUrl, { timeout: 180000 });

        const data = await page.evaluate(() => {
            const div = document.querySelector("#booktxthtml");
            const content = div
                ? Array.from(div.querySelectorAll("p"))
                    .map(p => p.innerText.trim())
                    .filter(t => t.length > 0)
                    .join("\n")
                : '';

            let titleText = '';
            const h1 = document.querySelector("h1");
            if (h1) titleText = h1.innerText.trim();
            else if (document.title) titleText = document.title.trim();
            titleText = titleText.replace(/[\(\（].*?[\)\）]/g, '').trim();

            return { content, title: titleText };
        });

        content = data.content;
        title = data.title;

    } catch (e) {
        console.log(`Chapter error: ${chapterUrl}`);
    } finally {
        await page.close();
    }
    return { content, title };
}

async function crawlChapters(context, bookId, numChapters = 20) {
    const xsUrl = `${BASE_URL}/xs/${bookId}/1/`;
    const page = await context.newPage();
    let chapters = [];

    try {
        await page.goto(xsUrl, { timeout: 180000 });

        chapters = await page.evaluate(({ num, baseUrl }) => {
            const lis = Array.from(document.querySelectorAll("div.all ul li")).slice(0, num);
            return lis.map(li => {
                const a = li.querySelector("a");
                if (!a) return null;
                const onclick = a.getAttribute("onclick") || "";
                const match = onclick.match(/location\.href='(.*?)'/);
                const url = match ? match[1] : null;
                return { url: url ? baseUrl + url.replace(/\\/g, "") : null };
            }).filter(x => x);
        }, { num: numChapters, baseUrl: BASE_URL });

    } catch (e) {
        console.log(`List chapter error: ${xsUrl}`);
    }

    await page.close();

    for (let i = 0; i < chapters.length; i += MAX_CHAPTER_TABS) {
        const batch = chapters.slice(i, i + MAX_CHAPTER_TABS).map(
            ch => ch.url ? crawlChapterContent(context, ch.url) : Promise.resolve({})
        );
        const results = await Promise.all(batch);

        results.forEach((res, idx) => {
            chapters[i + idx].content = res.content || "";
            chapters[i + idx].title = res.title || "";
        });
    }

    return chapters;
}

async function crawlBookDetail(context, bookUrl) {
    const page = await context.newPage();
    let author = "";
    let genres = "";

    try {
        await page.goto(bookUrl, { timeout: 180000 });

        const d = await page.evaluate(() => {
            let authorText = '';
            const authorP = Array.from(document.querySelectorAll("p"))
                .find(p => p.querySelector("b")?.innerText.trim() === "作者：");

            if (authorP) {
                const a = authorP.querySelector("a");
                if (a) authorText = a.innerText.trim();
            }

            let genreText = '';
            const ol = document.querySelector("ol.container");
            if (ol && ol.querySelectorAll("li").length >= 2)
                genreText = ol.querySelectorAll("li")[1].innerText.trim();

            return { author: authorText, genres: genreText };
        });

        author = d.author;
        genres = d.genres;

    } catch { }

    await page.close();
    return { author, genres };
}

async function crawlBooks(browser, pageNum = 1, numChapters = 20) {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/ben/all/${pageNum}/`, { timeout: 180000 });

    let books = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("dl"))
            .filter(dl => !dl.closest('div.right.hidden-xs'))
            .map(dl => {
                const a = dl.querySelector("dt a");
                const img = dl.querySelector("a.cover img");
                const desc = dl.querySelector("dd");
                const match = a?.getAttribute("href")?.match(/\/kanshu\/(\d+)\//);

                return {
                    url: a ? (a.href.startsWith("http") ? a.href : "https://www.writerworking.net" + a.getAttribute("href")) : null,
                    bookId: match ? match[1] : null,
                    title: a?.title || a?.innerText,
                    cover_image: img ? (img.getAttribute("data-src") || img.getAttribute("src")) : null,
                    description: desc ? desc.innerText.trim() : "",
                    genres: [],
                    chapters: []
                };
            });
    });

    await page.close();

    const result = [];
    for (let i = 0; i < books.length; i += MAX_BOOK_TABS) {
        const batch = books.slice(i, i + MAX_BOOK_TABS).map(async book => {
            if (book.url && book.bookId) {
                const detail = await crawlBookDetail(context, book.url);
                book.author = detail.author;
                book.genres = detail.genres ? [detail.genres] : [];
                book.chapters = await crawlChapters(context, book.bookId, numChapters);
            }
            return book;
        });

        result.push(...await Promise.all(batch));
    }

    await context.close();
    return result;
}

// ===========================================
// WORKER MODE (CHÍNH FILE NÀY TỰ LÀM WORKER)
// ===========================================
if (process.argv.includes("--worker")) {
    process.on("message", async ({ pageNum, numChapters }) => {
        try {
            const browser = await chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });

            const data = await crawlBooks(browser, pageNum, numChapters);
            console.log("DONE. Books:", data.length);

            process.send({ status: "done", total: data.length });
            await browser.close();
        } catch (err) {
            process.send({ status: "error", error: err.toString() });
        }
        process.exit(0);
    });
    return; // KHÔNG KHỞI TẠO SERVER KHI LÀ WORKER
}

// ===========================================
// SERVER MODE
// ===========================================
app.get("/crawl", (req, res) => {
    const pageNum = parseInt(req.query.page) || 1;
    const numChapters = parseInt(req.query.num_chapters) || 5;

    const worker = fork(process.argv[1], ["--worker"]);

    worker.send({ pageNum, numChapters });

    res.json({
        status: "started",
        worker_pid: worker.pid
    });

    worker.on("message", msg => console.log("[Worker]", msg));
});

app.listen(3000, () => {
    console.log("Server running on port 3000");
});
