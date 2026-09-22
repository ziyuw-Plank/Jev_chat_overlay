"auto";

/*
 * Jev Chat Overlay
 *
 * 通用聊天悬浮分析层：
 * - 自动识别当前前台 App
 * - WeChat / QQ / TIM / Telegram / WhatsApp / LINE / Discord /
 *   Signal / Messenger 有 profile；未知 App 自动走 Generic
 * - Accessibility 优先，OCR fallback
 * - 视口：找最大可滚动列表 + 底部输入框，不靠包名死比例
 * - 气泡：用左右边距判断收/发，宽气泡不再丢成 unknown
 * - 丢掉群名片、时间戳、引用重复、标题栏
 * - 图片/表情：截取气泡区域 -> 放大 PNG -> DeepSeek Vision 逐字转录
 * - DeepSeek：给每条对方消息拆互斥假说（hook + options）
 * - Jev：对假打分，输出百分比分布（这才是 Jev）
 * - DeepSeek：只写一条「建议动作」，口吻像挡需求膨胀的项目经理
 *
 * UI：
 * - 所有框、连线、分析卡都画在一个 Canvas 上
 * - 用 Canvas.getLocationOnScreen() 自动校正 Overlay 坐标
 * - 拖整条控制栏移动；点 J 分析；点 × 清空；点 ◉ 隐藏；点 ≡ 复制
 *
 * 不自动发送任何消息。
 */

// ============================================================================
// 0. CONFIG
// ============================================================================

var CONFIG = {
    JEV: {
        apiKey: "PASTE_TYPESAFE_API_KEY_HERE",
        endpoint: "https://api.typesafe.ai/v1/systemone",
        model: "jev-latest"
    },

    LLM: {
        apiKey: "PASTE_DEEPSEEK_API_KEY_HERE",
        endpoint: "https://api.deepseek.com/chat/completions",
        model: "deepseek-flash",
        temperature: 0.66,
        maxTokens: 1200
    },

    relationship:
        "对方是当前正在和我聊天的人。除非可见聊天明确，否则不要自行假设恋爱、同事、亲属、上下级等关系。",

    maxMessages: 24,
    maxAnalyzedOther: 7,

    useOcrFallback: true,

    genericTopRatio: 0.075,
    genericBottomRatio: 0.935,

    drawMyMessages: true,
    drawRecognizedText: true,

    multimodal: {
        enabled: true,
        maxMediaMessages: 4,

        // 表情包只放大到能看清；截图再放大。过大的像素风会被模型说成“模糊格子”。
        stickerLongSide: 640,
        shotLongSide: 1100,

        format: "jpg",
        quality: 84,
        detail: "high",

        // 检测近纯黑/纯色等无效截图
        rejectBlankCrop: true
    },

    debug: true
};


// ============================================================================
// 1. APP PROFILES
// ============================================================================

var APP_PROFILES = [
    {
        name: "WeChat",
        packages: ["com.tencent.mm"],
        topRatio: 0.090,
        bottomRatio: 0.935,
        outgoingSide: "right"
    },
    {
        name: "QQ",
        packages: ["com.tencent.mobileqq"],
        topRatio: 0.080,
        bottomRatio: 0.935,
        outgoingSide: "right"
    },
    {
        name: "TIM",
        packages: ["com.tencent.tim"],
        topRatio: 0.080,
        bottomRatio: 0.935,
        outgoingSide: "right"
    },
    {
        name: "Telegram",
        packages: [
            "org.telegram.messenger",
            "org.telegram.messenger.web",
            "org.telegram.plus"
        ],
        topRatio: 0.075,
        bottomRatio: 0.930,
        outgoingSide: "right"
    },
    {
        name: "WhatsApp",
        packages: ["com.whatsapp"],
        topRatio: 0.075,
        bottomRatio: 0.930,
        outgoingSide: "right"
    },
    {
        name: "LINE",
        packages: ["jp.naver.line.android"],
        topRatio: 0.075,
        bottomRatio: 0.925,
        outgoingSide: "right"
    },
    {
        name: "Discord",
        packages: ["com.discord"],
        topRatio: 0.075,
        bottomRatio: 0.925,
        outgoingSide: "right"
    },
    {
        name: "Signal",
        packages: ["org.thoughtcrime.securesms"],
        topRatio: 0.075,
        bottomRatio: 0.930,
        outgoingSide: "right"
    },
    {
        name: "Messenger",
        packages: ["com.facebook.orca"],
        topRatio: 0.075,
        bottomRatio: 0.930,
        outgoingSide: "right"
    }
];

function getProfile(pkg) {
    for (var i = 0; i < APP_PROFILES.length; i++) {
        var p = APP_PROFILES[i];

        for (var j = 0; j < p.packages.length; j++) {
            if (p.packages[j] === pkg) {
                return {
                    name: p.name,
                    packageName: pkg,
                    topRatio: p.topRatio,
                    bottomRatio: p.bottomRatio,
                    outgoingSide: p.outgoingSide,
                    generic: false
                };
            }
        }
    }

    return {
        name: "Generic",
        packageName: pkg,
        topRatio: CONFIG.genericTopRatio,
        bottomRatio: CONFIG.genericBottomRatio,
        outgoingSide: "right",
        generic: true
    };
}


// ============================================================================
// 2. BOOT
// ============================================================================

auto.waitFor();

if (!CONFIG.JEV.apiKey ||
    CONFIG.JEV.apiKey === "PASTE_TYPESAFE_API_KEY_HERE") {
    toast("请填写 TypeSafe API Key");
    throw new Error("Missing TypeSafe API key");
}

if (!CONFIG.LLM.apiKey ||
    CONFIG.LLM.apiKey === "PASTE_DEEPSEEK_API_KEY_HERE") {
    toast("请填写 DeepSeek API Key");
    throw new Error("Missing DeepSeek API key");
}

var DENSITY =
    context.getResources()
        .getDisplayMetrics()
        .density;

function dp(n) {
    return Math.round(n * DENSITY);
}

var SCREEN_W = device.width;
var SCREEN_H = device.height;

var SELF_PACKAGE = "";
try {
    SELF_PACKAGE = String(context.getPackageName());
} catch (ignoreSelf) {}

var running = true;
var analyzing = false;
var captureReady = false;

var overlayVisible = true;
var captureHidden = false;
var watchedPackage = "";

var overlayOriginX = 0;
var overlayOriginY = 0;

var currentProfile = null;
var currentCapture = null;
var currentAnalyses = {};
var currentReplies = {};
var currentHypotheses = {};
var currentGlobalJev = null;


// ============================================================================
// 3. SINGLE CANVAS OVERLAY
// ============================================================================

var overlay = floaty.rawWindow(
    <canvas id="canvas"/>
);

ui.run(function () {
    overlay.setPosition(0, 0);
    overlay.setSize(SCREEN_W, SCREEN_H);
    overlay.setTouchable(false);
});

function refreshOverlayOrigin() {
    try {
        ui.run(function () {
            var loc =
                java.lang.reflect.Array.newInstance(
                    java.lang.Integer.TYPE,
                    2
                );

            overlay.canvas.getLocationOnScreen(loc);

            overlayOriginX = Number(loc[0]);
            overlayOriginY = Number(loc[1]);
        });
    } catch (e) {
        overlayOriginX = 0;
        overlayOriginY = 0;

        debugLog(
            "COORD",
            "getLocationOnScreen failed: " +
            readableError(e)
        );
    }

    debugLog(
        "COORD",
        "origin=(" +
        overlayOriginX +
        "," +
        overlayOriginY +
        ")"
    );
}

sleep(120);
refreshOverlayOrigin();

function ox(screenX) {
    return screenX - overlayOriginX;
}

function oy(screenY) {
    return screenY - overlayOriginY;
}

var paint = new Paint();
paint.setAntiAlias(true);
paint.setTypeface(Typeface.DEFAULT_BOLD);
paint.setStrokeJoin(Paint.Join.ROUND);

overlay.canvas.on("draw", function (canvas) {
    try {
        if (!running) {
            return;
        }

        canvas.drawColor(
            0xFFFFFF,
            android.graphics.PorterDuff.Mode.CLEAR
        );

        var capture =
            currentCapture;

        if (captureHidden ||
            !overlayVisible ||
            !capture ||
            !capture.messages ||
            capture.messages.length === 0) {
            return;
        }

        drawOverlay(
            canvas,
            capture
        );
    } catch (drawErr) {
        debugLog(
            "DRAW",
            readableError(
                drawErr
            )
        );
    }
});

function invalidateOverlay() {
    try {
        ui.run(function () {
            overlay.canvas.invalidate();
        });
    } catch (ignore) {}

    raiseControl();
}

function raiseControl() {
    try {
        ui.run(function () {
            control.setTouchable(true);
            control.setPosition(
                controlX,
                controlY
            );
        });
    } catch (ignore) {}
}


// ============================================================================
// 4. CONTROL BAR
// ============================================================================

var control = floaty.rawWindow(
    <horizontal
        id="bar"
        bg="#ED1A1D23"
        padding="4"
        gravity="center_vertical">

        <text
            id="run"
            text="J"
            textColor="#FFFFFF"
            textSize="20sp"
            textStyle="bold"
            gravity="center"
            w="42"
            h="42"/>

        <text
            id="eye"
            text="◉"
            textColor="#9FE2D6"
            textSize="18sp"
            gravity="center"
            w="38"
            h="42"/>

        <text
            id="list"
            text="≡"
            textColor="#D4D9E0"
            textSize="22sp"
            gravity="center"
            w="38"
            h="42"/>

        <text
            id="clear"
            text="×"
            textColor="#B9BEC7"
            textSize="22sp"
            gravity="center"
            w="38"
            h="42"/>

    </horizontal>
);

var controlX =
    Math.max(
        0,
        SCREEN_W - dp(174)
    );

var controlY =
    Math.round(
        SCREEN_H * 0.42
    );

ui.run(function () {
    control.setSize(
        dp(176),
        dp(52)
    );

    control.setTouchable(true);

    control.setPosition(
        controlX,
        controlY
    );
});

// 整条栏可拖动。轻点按落点分发：J 分析 / ◉ 显隐 / ≡ 复制 / × 清空。
var controlTouchDownRawX = 0;
var controlTouchDownRawY = 0;
var controlTouchStartX = 0;
var controlTouchStartY = 0;
var controlTouchMoved = false;

function maskedAction(event) {
    try {
        if (event.getActionMasked) {
            return event.getActionMasked();
        }
    } catch (ignore) {}

    return event.getAction() & 255;
}

function pointInView(view, rawX, rawY) {
    if (!view) {
        return false;
    }

    try {
        var loc =
            java.lang.reflect.Array.newInstance(
                java.lang.Integer.TYPE,
                2
            );

        view.getLocationOnScreen(loc);

        var l = Number(loc[0]);
        var t = Number(loc[1]);
        var r = l + view.getWidth();
        var b = t + view.getHeight();

        return rawX >= l &&
            rawX < r &&
            rawY >= t &&
            rawY < b;
    } catch (e) {
        return false;
    }
}

function toggleOverlayVisible() {
    overlayVisible =
        !overlayVisible;

    ui.run(function () {
        control.eye.setText(
            overlayVisible
                ? "◉"
                : "○"
        );
    });

    invalidateOverlay();

    toast(
        overlayVisible
            ? "标注已恢复"
            : "标注已隐藏"
    );
}

function runControlRole(role) {
    if (role === "eye") {
        toggleOverlayVisible();
        return;
    }

    if (role === "list") {
        threads.start(function () {
            showReplyPicker();
        });
        return;
    }

    if (role === "clear") {
        clearResults();
        return;
    }

    startAnalysis();
}

function roleFromBarX(view, event) {
    var width = 1;

    try {
        width =
            view.getWidth() ||
            1;
    } catch (ignoreW) {}

    var x = 0;

    try {
        x = event.getX();
    } catch (ignoreX) {}

    var t =
        x / Math.max(1, width);

    if (t < 0.27) {
        return "run";
    }

    if (t < 0.50) {
        return "eye";
    }

    if (t < 0.73) {
        return "list";
    }

    return "clear";
}

var controlGestureHandled = false;

function bindControlDrag(view, role) {
    if (!view) {
        return;
    }

    view.setOnTouchListener(function (v, event) {
        var action =
            maskedAction(
                event
            );

        if (action === 0) {
            try {
                var parent =
                    v.getParent
                        ? v.getParent()
                        : null;

                if (parent &&
                    parent.requestDisallowInterceptTouchEvent) {
                    parent.requestDisallowInterceptTouchEvent(
                        true
                    );
                }
            } catch (ignore) {}

            controlTouchDownRawX =
                event.getRawX();

            controlTouchDownRawY =
                event.getRawY();

            controlTouchStartX =
                controlX;

            controlTouchStartY =
                controlY;

            controlTouchMoved =
                false;

            controlGestureHandled =
                false;

            return true;
        }

        if (action === 2) {
            var dx =
                event.getRawX() -
                controlTouchDownRawX;

            var dy =
                event.getRawY() -
                controlTouchDownRawY;

            if (Math.abs(dx) > dp(6) ||
                Math.abs(dy) > dp(6)) {
                controlTouchMoved =
                    true;
            }

            var barW =
                Math.max(
                    dp(156),
                    control.getWidth() ||
                    0
                );

            var barH =
                Math.max(
                    dp(48),
                    control.getHeight() ||
                    0
                );

            controlX =
                clamp(
                    Math.round(
                        controlTouchStartX +
                        dx
                    ),
                    0,
                    Math.max(
                        0,
                        SCREEN_W -
                        barW
                    )
                );

            controlY =
                clamp(
                    Math.round(
                        controlTouchStartY +
                        dy
                    ),
                    0,
                    Math.max(
                        0,
                        SCREEN_H -
                        barH
                    )
                );

            control.setPosition(
                controlX,
                controlY
            );

            return true;
        }

        if (action === 1) {
            if (!controlTouchMoved &&
                !controlGestureHandled) {

                controlGestureHandled =
                    true;

                var hit =
                    role === "bar"
                        ? roleFromBarX(
                            v,
                            event
                        )
                        : role;

                runControlRole(hit);
            }

            return true;
        }

        return true;
    });
}

ui.run(function () {
    try {
        control.bar.setClickable(true);
        control.run.setClickable(true);
        control.eye.setClickable(true);
        control.list.setClickable(true);
        control.clear.setClickable(true);
    } catch (ignoreClickable) {}

    bindControlDrag(control.bar, "bar");
    bindControlDrag(control.run, "run");
    bindControlDrag(control.eye, "eye");
    bindControlDrag(control.list, "list");
    bindControlDrag(control.clear, "clear");
});


// ============================================================================
// 5. MAIN
// ============================================================================

function startAnalysis() {
    if (analyzing) {
        toast("正在分析");
        return;
    }

    analyzing = true;

    threads.start(function () {
        try {
            clearResults(false);

            refreshOverlayOrigin();

            currentProfile =
                resolveForegroundProfile();

            toast(
                "识别 " +
                currentProfile.name +
                "…"
            );

            var capture =
                captureConversation(
                    currentProfile
                );

            if (!capture.messages ||
                capture.messages.length === 0) {

                throw new Error(
                    "没有识别到聊天消息。\n" +
                    "App=" +
                    currentProfile.name +
                    "\npackage=" +
                    currentProfile.packageName
                );
            }

            currentCapture =
                capture;

            chooseTargets(
                currentCapture
            );

            computeCardLayout(
                currentCapture
            );

            invalidateOverlay();

            debugLog(
                "CAPTURE",
                JSON.stringify(
                    captureForDebug(
                        currentCapture
                    ),
                    null,
                    2
                )
            );

            if (capture.readableMediaCount > 0) {
                toast(
                    "图片/表情 " +
                    capture.readableMediaCount +
                    " 张 · 读图…"
                );

                var visual =
                    understandMediaWithDeepSeek(
                        currentCapture
                    );

                applyVisualUnderstanding(
                    currentCapture,
                    visual
                );

                invalidateOverlay();
            }

            toast(
                "拆假说 " +
                countTargets(
                    currentCapture
                ) +
                " 条…"
            );

            try {
                currentHypotheses =
                    extractHypotheses(
                        currentCapture
                    );
            } catch (hypErr) {
                debugLog(
                    "HYPOTHESES_FAIL",
                    readableError(
                        hypErr
                    )
                );

                currentHypotheses =
                    {};

                toast(
                    "假说失败，Jev 走兜底分类"
                );
            }

            attachHypotheses(
                currentCapture,
                currentHypotheses
            );

            computeCardLayout(
                currentCapture
            );

            invalidateOverlay();

            toast(
                "Jev 打分…"
            );

            currentAnalyses =
                analyzeWithJev(
                    currentCapture,
                    currentHypotheses
                );

            currentGlobalJev =
                currentAnalyses._global ||
                null;

            invalidateOverlay();

            toast(
                "写建议动作…"
            );

            currentReplies =
                generateActions(
                    currentCapture,
                    currentHypotheses,
                    currentAnalyses
                );

            invalidateOverlay();

            overlayVisible = true;

            ui.run(function () {
                control.eye.setText("◉");
            });

            toast(
                "完成 · " +
                currentProfile.name +
                " · " +
                currentCapture.source
            );

        } catch (e) {
            var msg =
                readableError(e);

            debugLog(
                "ERROR",
                msg
            );

            toast(
                "失败：" +
                truncate(
                    msg,
                    100
                )
            );

        } finally {
            analyzing = false;
        }
    });
}

function clearResults(showToast) {
    currentCapture = null;
    currentAnalyses = {};
    currentReplies = {};
    currentHypotheses = {};
    currentGlobalJev = null;

    invalidateOverlay();

    if (showToast !== false) {
        toast("已清空");
    }
}


// ============================================================================
// 6. FOREGROUND APP / ADAPTER
// ============================================================================

function isIgnorablePackage(pkg) {
    if (!pkg) {
        return true;
    }

    if (pkg === SELF_PACKAGE) {
        return true;
    }

    return /systemui|launcher|permissioncontroller|inputmethod|miui\.home|android$/i
        .test(pkg);
}

function readForegroundPackage() {
    var live = "";

    try {
        live =
            String(
                currentPackage() ||
                ""
            );
    } catch (ignoreLive) {}

    if (!isIgnorablePackage(live)) {
        return live;
    }

    try {
        var root =
            auto.rootInActiveWindow;

        if (root) {
            var rp =
                String(
                    root.packageName() ||
                    ""
                );

            if (!isIgnorablePackage(rp)) {
                return rp;
            }
        }
    } catch (ignoreRoot) {}

    return live ||
        "unknown.package";
}

function activeRootFor(pkg) {
    var last = null;

    for (var i = 0; i < 8; i++) {
        try {
            last =
                auto.rootInActiveWindow;
        } catch (ignoreRoot) {
            last = null;
        }

        if (!last) {
            sleep(80);
            continue;
        }

        var rp = "";

        try {
            rp =
                String(
                    last.packageName() ||
                    ""
                );
        } catch (ignorePkg) {}

        if (!pkg ||
            pkg === "unknown.package" ||
            rp === pkg) {
            return last;
        }

        sleep(90);
    }

    return last;
}

function resolveForegroundProfile() {
    var pkg =
        readForegroundPackage();

    activeRootFor(pkg);

    watchedPackage = pkg;

    return getProfile(pkg);
}


// ============================================================================
// 7. CAPTURE -> UNIFIED Message[]
// ============================================================================

function captureConversation(profile) {
    var viewport =
        detectChatViewport(
            profile
        );

    profile.topY =
        viewport.topY;

    profile.bottomY =
        viewport.bottomY;

    profile.viewportVia =
        viewport.via;

    debugLog(
        "VIEWPORT",
        viewport.via +
        " y=" +
        viewport.topY +
        ".." +
        viewport.bottomY
    );

    var textItems = [];
    var mediaItems = [];

    try {
        textItems =
            collectTextFromAccessibility(
                profile
            );
    } catch (e) {
        debugLog(
            "A11Y_TEXT_FAIL",
            readableError(e)
        );
    }

    if (CONFIG.multimodal.enabled) {
        try {
            mediaItems =
                collectMediaFromAccessibility(
                    profile
                );
        } catch (e2) {
            debugLog(
                "A11Y_MEDIA_FAIL",
                readableError(e2)
            );
        }
    }

    var source = "A11Y";

    if (!isCaptureUsable(
        textItems
    )) {

        if (CONFIG.useOcrFallback) {
            try {
                var ocrItems =
                    collectTextFromOcr(
                        profile
                    );

                if (isCaptureUsable(
                    ocrItems
                )) {
                    textItems =
                        ocrItems;

                    source = "OCR";
                }
            } catch (e3) {
                debugLog(
                    "OCR_FAIL",
                    readableError(e3)
                );
            }
        }
    }

    var messages =
        mergeMessages(
            textItems,
            mediaItems
        );

    if (messages.length >
        CONFIG.maxMessages) {

        messages =
            messages.slice(
                -CONFIG.maxMessages
            );
    }

    assignIds(
        messages
    );

    assignImageRefs(
        messages
    );

    var capture = {
        source:
            source,

        packageName:
            profile.packageName,

        appName:
            profile.name,

        generic:
            profile.generic,

        viewportVia:
            profile.viewportVia ||
            "ratio",

        messages:
            messages,

        mediaCount:
            countMedia(
                messages
            ),

        readableMediaCount:
            0,

        protectedMediaCount:
            0
    };

    if (CONFIG.multimodal.enabled &&
        capture.mediaCount > 0) {

        attachMediaCrops(
            capture
        );
    }

    return capture;
}

function isCaptureUsable(items) {
    if (!items ||
        items.length === 0) {
        return false;
    }

    var chars = 0;

    for (var i = 0;
         i < items.length;
         i++) {

        chars +=
            (items[i].text || "")
                .length;
    }

    return chars >= 4;
}


// ============================================================================
// 8. ACCESSIBILITY TEXT
// ============================================================================

function chatTop(profile) {
    if (profile &&
        typeof profile.topY ===
            "number") {
        return profile.topY;
    }

    return Math.round(
        SCREEN_H *
        (
            (profile &&
             profile.topRatio) ||
            CONFIG.genericTopRatio
        )
    );
}

function chatBottom(profile) {
    if (profile &&
        typeof profile.bottomY ===
            "number") {
        return profile.bottomY;
    }

    return Math.round(
        SCREEN_H *
        (
            (profile &&
             profile.bottomRatio) ||
            CONFIG.genericBottomRatio
        )
    );
}

function detectChatViewport(profile) {
    var fallbackTop =
        Math.round(
            SCREEN_H *
            (
                (profile &&
                 profile.topRatio) ||
                CONFIG.genericTopRatio
            )
        );

    var fallbackBot =
        Math.round(
            SCREEN_H *
            (
                (profile &&
                 profile.bottomRatio) ||
                CONFIG.genericBottomRatio
            )
        );

    var root = null;

    try {
        root =
            activeRootFor(
                profile &&
                profile.packageName
            );
    } catch (ignoreRoot) {}

    if (!root) {
        return {
            topY: fallbackTop,
            bottomY: fallbackBot,
            via: "ratio"
        };
    }

    var inputTop = null;
    var bestList = null;
    var stack = [root];
    var guard = 0;

    while (stack.length > 0 &&
           guard < 12000) {

        guard++;

        var node =
            stack.pop();

        if (!node) {
            continue;
        }

        try {
            var count =
                node.childCount();

            for (var i = count - 1;
                 i >= 0;
                 i--) {

                var child =
                    node.child(i);

                if (child) {
                    stack.push(child);
                }
            }

            var b =
                node.bounds();

            if (!b) {
                continue;
            }

            var nodePkg = "";

            try {
                nodePkg =
                    String(
                        node.packageName() ||
                        ""
                    );
            } catch (ignoreNodePkg) {}

            if (profile &&
                profile.packageName &&
                profile.packageName !==
                    "unknown.package" &&
                nodePkg &&
                nodePkg !==
                    profile.packageName) {
                continue;
            }

            var cls = "";
            var desc = "";
            var scrollable = false;

            try {
                cls =
                    String(
                        node.className() ||
                        ""
                    );
            } catch (ignoreCls) {}

            try {
                var d =
                    node.desc();

                if (d != null) {
                    desc =
                        String(d);
                }
            } catch (ignoreDesc) {}

            try {
                scrollable =
                    !!node.scrollable();
            } catch (ignoreScroll) {}

            var w =
                b.right -
                b.left;

            var h =
                b.bottom -
                b.top;

            if (/EditText/i
                    .test(cls) &&
                b.top >
                    SCREEN_H *
                    0.58) {

                inputTop =
                    inputTop == null
                        ? b.top
                        : Math.min(
                            inputTop,
                            b.top
                        );
            }

            if (/语音|按住说话|表情|Stickers?|Send|更多功能/i
                    .test(desc) &&
                b.top >
                    SCREEN_H *
                    0.70) {

                inputTop =
                    inputTop == null
                        ? b.top
                        : Math.min(
                            inputTop,
                            b.top
                        );
            }

            var looksList =
                scrollable ||
                /RecyclerView|ListView|AbsListView/i
                    .test(cls);

            if (looksList &&
                w >
                    SCREEN_W *
                    0.62 &&
                h >
                    SCREEN_H *
                    0.28) {

                var area =
                    w * h;

                if (!bestList ||
                    area >
                        bestList.area) {

                    bestList = {
                        top:
                            b.top,
                        bottom:
                            b.bottom,
                        area:
                            area
                    };
                }
            }

        } catch (ignoreNode) {}
    }

    var topY =
        fallbackTop;

    var bottomY =
        fallbackBot;

    var via =
        "ratio";

    if (bestList) {
        topY =
            bestList.top;

        bottomY =
            Math.min(
                bottomY,
                bestList.bottom
            );

        via =
            "list";
    }

    if (inputTop != null) {
        bottomY =
            Math.min(
                bottomY,
                inputTop -
                dp(2)
            );

        if (via ===
            "ratio") {
            via =
                "input";
        } else {
            via =
                "list+input";
        }
    }

    if (bottomY -
            topY <
        SCREEN_H *
        0.20) {

        return {
            topY: fallbackTop,
            bottomY: fallbackBot,
            via: "ratio"
        };
    }

    return {
        topY: topY,
        bottomY: bottomY,
        via: via
    };
}

function collectTextFromAccessibility(
    profile
) {
    var root =
        activeRootFor(
            profile.packageName
        );

    if (!root) {
        return [];
    }

    var topY =
        chatTop(
            profile
        );

    var bottomY =
        chatBottom(
            profile
        );

    var stack = [root];
    var items = [];
    var guard = 0;

    while (stack.length > 0 &&
           guard < 10000) {

        guard++;

        var node =
            stack.pop();

        if (!node) {
            continue;
        }

        try {
            var count =
                node.childCount();

            for (var i = count - 1;
                 i >= 0;
                 i--) {

                var child =
                    node.child(i);

                if (child) {
                    stack.push(child);
                }
            }

            var pkg = "";

            try {
                pkg =
                    String(
                        node.packageName() ||
                        ""
                    );
            } catch (ignorePkg) {}

            if (profile.packageName &&
                pkg &&
                pkg !==
                    profile.packageName) {
                continue;
            }

            // 不 fallback 到 desc。
            var raw = "";

            try {
                var t =
                    node.text();

                if (t != null) {
                    raw =
                        String(t);
                }
            } catch (ignoreText) {}

            var text =
                cleanChatText(
                    raw
                );

            if (!text) {
                continue;
            }

            var b =
                node.bounds();

            if (!isPlausibleBounds(
                b,
                topY,
                bottomY
            )) {
                continue;
            }

            var side =
                sideFromBounds(
                    b,
                    profile
                );

            items.push({
                kind: "text",
                from: side,
                text: text,
                top: b.top,
                bottom: b.bottom,
                left: b.left,
                right: b.right,
                confidence: 1.0
            });

        } catch (ignoreNode) {}
    }

    return filterMessageItems(
        normalizeTextItems(
            items
        )
    );
}


// ============================================================================
// 9. ACCESSIBILITY MEDIA
// ============================================================================

function collectMediaFromAccessibility(
    profile
) {
    var root =
        activeRootFor(
            profile.packageName
        );

    if (!root) {
        return [];
    }

    var topY =
        chatTop(
            profile
        );

    var bottomY =
        chatBottom(
            profile
        );

    var stack = [root];
    var candidates = [];
    var guard = 0;

    while (stack.length > 0 &&
           guard < 11000) {

        guard++;

        var node =
            stack.pop();

        if (!node) {
            continue;
        }

        try {
            var count =
                node.childCount();

            for (var i = count - 1;
                 i >= 0;
                 i--) {

                var child =
                    node.child(i);

                if (child) {
                    stack.push(child);
                }
            }

            var pkg = "";

            try {
                pkg =
                    String(
                        node.packageName() ||
                        ""
                    );
            } catch (ignorePkg) {}

            if (profile.packageName &&
                pkg &&
                pkg !==
                    profile.packageName) {
                continue;
            }

            var b =
                node.bounds();

            if (!b ||
                b.bottom <= topY ||
                b.top >= bottomY) {
                continue;
            }

            var w =
                b.right -
                b.left;

            var h =
                b.bottom -
                b.top;

            if (w <= dp(20) ||
                h <= dp(20)) {
                continue;
            }

            var desc = "";
            var cls = "";
            var clickable = false;

            try {
                var d =
                    node.desc();

                if (d != null) {
                    desc =
                        String(d);
                }
            } catch (ignoreDesc) {}

            try {
                cls =
                    String(
                        node.className() ||
                        ""
                    );
            } catch (ignoreClass) {}

            try {
                clickable =
                    !!node.clickable();
            } catch (ignoreClick) {}

            var containerHint =
                /^(Images?|Photos?|Pictures?|Sticker|GIF|图片|照片|表情|动图|贴纸|表情包)$/i
                    .test(
                        desc.trim()
                    );

            var looksImage =
                /ImageView/i
                    .test(cls) ||
                containerHint ||
                /image|photo|picture|sticker|emoji|gif|meme|图片|照片|表情|动图|贴纸|表情包/i
                    .test(desc);

            if (count > 0 &&
                !containerHint) {
                continue;
            }

            if (!looksImage) {
                continue;
            }

            if (/profile\s*photo|avatar|头像|head\s*image/i
                .test(desc)) {
                continue;
            }

            var nearLeft =
                b.left <
                SCREEN_W * 0.11;

            var nearRight =
                b.right >
                SCREEN_W * 0.89;

            // 小 + 靠边 = 头像/工具 icon
            if ((nearLeft ||
                 nearRight) &&
                w < SCREEN_W * 0.16 &&
                h < SCREEN_H * 0.09) {
                continue;
            }

            if (w > SCREEN_W * 0.90 ||
                h > SCREEN_H * 0.52) {
                continue;
            }

            var side =
                sideFromBounds(
                    b,
                    profile
                );

            var mediaHint =
                cleanMediaHint(
                    desc,
                    cls
                );

            candidates.push({
                kind: "media",
                from: side,
                text: "[图片/表情包]",
                mediaHint:
                    mediaHint,
                top: b.top,
                bottom: b.bottom,
                left: b.left,
                right: b.right,
                confidence: 1.0,
                captureStatus: "pending"
            });

        } catch (ignoreNode) {}
    }

    candidates.sort(function (a, b) {
        return a.top - b.top;
    });

    var out = [];

    for (var j = 0;
         j < candidates.length;
         j++) {

        var cur =
            candidates[j];

        var dup = false;

        for (var k = 0;
             k < out.length;
             k++) {

            if (rectIoU(
                cur,
                out[k]
            ) > 0.70) {
                dup = true;
                break;
            }
        }

        if (!dup) {
            out.push(cur);
        }
    }

    return out.slice(
        -CONFIG.multimodal
            .maxMediaMessages
    );
}


// ============================================================================
// 10. OCR FALLBACK
// ============================================================================

function collectTextFromOcr(
    profile
) {
    if (!ensureCapturePermission()) {
        throw new Error(
            "截图权限不可用"
        );
    }

    var saved =
        hideWindowsForCapture();

    var screen = null;
    var clip = null;

    try {
        sleep(160);

        screen =
            captureScreen();

        if (!screen) {
            throw new Error(
                "captureScreen() = null"
            );
        }

        var y1 =
            chatTop(
                profile
            );

        var y2 =
            chatBottom(
                profile
            );

        var h =
            Math.max(
                1,
                y2 - y1
            );

        clip =
            images.clip(
                screen,
                0,
                y1,
                SCREEN_W,
                h
            );

        var results =
            ocr.detect(
                clip
            );

        var items = [];

        if (results &&
            results.length) {

            for (var i = 0;
                 i < results.length;
                 i++) {

                var r =
                    results[i];

                var text = "";

                try {
                    text =
                        String(
                            r.text ||
                            r.label ||
                            ""
                        );
                } catch (ignore0) {}

                text =
                    cleanChatText(
                        text
                    );

                if (!text ||
                    !r.bounds) {
                    continue;
                }

                var b = {
                    left:
                        r.bounds.left,
                    right:
                        r.bounds.right,
                    top:
                        r.bounds.top +
                        y1,
                    bottom:
                        r.bounds.bottom +
                        y1
                };

                if (!isPlausibleBounds(
                    b,
                    y1,
                    y2
                )) {
                    continue;
                }

                var side =
                    sideFromBounds(
                        b,
                        profile
                    );

                items.push({
                    kind: "text",
                    from: side,
                    text: text,
                    top: b.top,
                    bottom: b.bottom,
                    left: b.left,
                    right: b.right,
                    confidence:
                        typeof r.confidence ===
                            "number"
                            ? r.confidence
                            : null
                });
            }
        }

        return filterMessageItems(
            normalizeTextItems(
                items
            )
        );

    } finally {
        try {
            if (clip &&
                clip.recycle) {
                clip.recycle();
            }
        } catch (ignore1) {}

        try {
            if (screen &&
                screen.recycle) {
                screen.recycle();
            }
        } catch (ignore2) {}

        restoreWindowsAfterCapture(
            saved
        );
    }
}

function ensureCapturePermission() {
    if (captureReady) {
        return true;
    }

    try {
        captureReady =
            !!requestScreenCapture(false);
    } catch (e) {
        captureReady = false;
    }

    return captureReady;
}


// ============================================================================
// 11. MEDIA CROP -> BASE64
// ============================================================================

function attachMediaCrops(capture) {
    if (!ensureCapturePermission()) {
        forEachMedia(
            capture.messages,
            function (m) {
                m.captureStatus =
                    "no_screenshot_permission";
            }
        );

        return;
    }

    var saved =
        hideWindowsForCapture();

    var screen = null;

    try {
        screen =
            captureScreen();

        if (!screen) {
            throw new Error(
                "captureScreen() = null"
            );
        }

        var bmpW =
            SCREEN_W;

        var bmpH =
            SCREEN_H;

        try {
            bmpW =
                screen.getWidth();
        } catch (ignoreW) {}

        try {
            bmpH =
                screen.getHeight();
        } catch (ignoreH) {}

        var scaleX =
            bmpW /
            Math.max(
                1,
                SCREEN_W
            );

        var scaleY =
            bmpH /
            Math.max(
                1,
                SCREEN_H
            );

        debugLog(
            "CAPTURE_BITMAP",
            bmpW +
            "x" +
            bmpH +
            " scale=" +
            scaleX.toFixed(3) +
            "," +
            scaleY.toFixed(3)
        );

        for (var i = 0;
             i < capture.messages.length;
             i++) {

            var m =
                capture.messages[i];

            if (m.kind !== "media") {
                continue;
            }

            // 多给一点 padding，但不要把头像/相邻气泡吃进来。
            var pad =
                dp(8);

            var x =
                clamp(
                    Math.round(
                        (m.left - pad) *
                        scaleX
                    ),
                    0,
                    bmpW - 1
                );

            var y =
                clamp(
                    Math.round(
                        (m.top - pad) *
                        scaleY
                    ),
                    0,
                    bmpH - 1
                );

            var right =
                clamp(
                    Math.round(
                        (m.right + pad) *
                        scaleX
                    ),
                    x + 1,
                    bmpW
                );

            var bottom =
                clamp(
                    Math.round(
                        (m.bottom + pad) *
                        scaleY
                    ),
                    y + 1,
                    bmpH
                );

            var w =
                right - x;

            var h =
                bottom - y;

            var crop = null;
            var prepared = null;

            try {
                crop =
                    images.clip(
                        screen,
                        x,
                        y,
                        w,
                        h
                    );

                if (!crop) {
                    m.captureStatus =
                        "crop_failed";
                    continue;
                }

                if (CONFIG.multimodal
                    .rejectBlankCrop &&
                    !isCropInformative(
                        crop
                    )) {

                    m.captureStatus =
                        "protected_or_blank";

                    capture
                        .protectedMediaCount++;

                    continue;
                }

                prepared =
                    upscaleForVision(
                        crop
                    );

                var b64 =
                    images.toBase64(
                        prepared,
                        CONFIG.multimodal
                            .format,
                        CONFIG.multimodal
                            .quality
                    );

                var mime =
                    CONFIG.multimodal
                        .format ===
                    "jpg"
                        ? "jpeg"
                        : CONFIG.multimodal
                            .format;

                m.imageDataUrl =
                    "data:image/" +
                    mime +
                    ";base64," +
                    b64;

                m.captureStatus =
                    "ok";

                capture
                    .readableMediaCount++;

            } catch (mediaErr) {
                m.captureStatus =
                    "capture_error";

                debugLog(
                    "MEDIA_CROP",
                    "#" +
                    m.id +
                    " " +
                    readableError(
                        mediaErr
                    )
                );

            } finally {
                // prepared 可能就是 crop；
                // AutoJs6 images.toBase64 可能会消费包装对象，
                // recycle 都用 try/catch。
                try {
                    if (prepared &&
                        prepared !== crop &&
                        prepared.recycle) {
                        prepared.recycle();
                    }
                } catch (ignoreP) {}

                try {
                    if (crop &&
                        crop.recycle) {
                        crop.recycle();
                    }
                } catch (ignoreC) {}
            }
        }

    } finally {
        try {
            if (screen &&
                screen.recycle) {
                screen.recycle();
            }
        } catch (ignoreS) {}

        restoreWindowsAfterCapture(
            saved
        );
    }
}

function upscaleForVision(img) {
    var w =
        img.getWidth();

    var h =
        img.getHeight();

    var longSide =
        Math.max(
            w,
            h
        );

    var target =
        longSide < 360
            ? CONFIG.multimodal
                .stickerLongSide
            : CONFIG.multimodal
                .shotLongSide;

    if (longSide >= target) {
        return img;
    }

    var scale =
        Math.min(
            3,
            target /
            Math.max(
                1,
                longSide
            )
        );

    var nw =
        Math.max(
            1,
            Math.round(
                w * scale
            )
        );

    var nh =
        Math.max(
            1,
            Math.round(
                h * scale
            )
        );

    try {
        return images.resize(
            img,
            [nw, nh],
            "INTER_CUBIC"
        );
    } catch (ignoreResize) {
        return images.resize(
            img,
            [nw, nh]
        );
    }
}

function cleanMediaHint(desc, cls) {
    var s =
        String(
            desc ||
            ""
        ).trim();

    if (s &&
        !looksLikeClassName(s) &&
        !/^(Images?|Photos?|Pictures?)$/i
            .test(s)) {
        return s;
    }

    return "图片";
}

function looksLikeClassName(s) {
    s =
        String(
            s ||
            ""
        );

    return /^android\./i
            .test(s) ||
        /ImageView|FrameLayout|ViewGroup|ImageButton|TextureView/i
            .test(s);
}

// 简单采样：如果整张裁剪几乎同一亮度，视为黑屏/保护层/无效图。
function isCropInformative(img) {
    try {
        var w =
            img.getWidth();

        var h =
            img.getHeight();

        if (w < 4 ||
            h < 4) {
            return false;
        }

        var values = [];

        var stepsX = 6;
        var stepsY = 6;

        for (var iy = 1;
             iy <= stepsY;
             iy++) {

            for (var ix = 1;
                 ix <= stepsX;
                 ix++) {

                var x =
                    Math.min(
                        w - 1,
                        Math.max(
                            0,
                            Math.round(
                                ix *
                                w /
                                (stepsX + 1)
                            )
                        )
                    );

                var y =
                    Math.min(
                        h - 1,
                        Math.max(
                            0,
                            Math.round(
                                iy *
                                h /
                                (stepsY + 1)
                            )
                        )
                    );

                var c =
                    images.pixel(
                        img,
                        x,
                        y
                    );

                var lum =
                    0.2126 *
                        colors.red(c) +
                    0.7152 *
                        colors.green(c) +
                    0.0722 *
                        colors.blue(c);

                values.push(
                    lum
                );
            }
        }

        var min = 255;
        var max = 0;
        var sum = 0;

        for (var i = 0;
             i < values.length;
             i++) {

            min =
                Math.min(
                    min,
                    values[i]
                );

            max =
                Math.max(
                    max,
                    values[i]
                );

            sum +=
                values[i];
        }

        var mean =
            sum /
            values.length;

        var varSum = 0;

        for (var j = 0;
             j < values.length;
             j++) {

            var d =
                values[j] -
                mean;

            varSum +=
                d * d;
        }

        var std =
            Math.sqrt(
                varSum /
                values.length
            );

        // 近纯黑、近纯白、近纯色都很可疑。
        return (
            (max - min) >= 14 ||
            std >= 7
        );

    } catch (e) {
        // 无法判断时不误杀。
        return true;
    }
}


// ============================================================================
// 12. NORMALIZE / MERGE
// ============================================================================

function normalizeTextItems(items) {
    if (!items ||
        items.length === 0) {
        return [];
    }

    items.sort(function (a, b) {
        if (Math.abs(
            a.top - b.top
        ) > dp(3)) {
            return a.top -
                b.top;
        }

        return a.left -
            b.left;
    });

    var dedup = [];
    var seen = {};

    for (var i = 0;
         i < items.length;
         i++) {

        var x =
            items[i];

        var key =
            x.from + "|" +
            x.text + "|" +
            Math.round(
                x.top /
                Math.max(
                    1,
                    dp(4)
                )
            ) + "|" +
            Math.round(
                x.left /
                Math.max(
                    1,
                    dp(6)
                )
            );

        if (seen[key]) {
            continue;
        }

        seen[key] = true;
        dedup.push(
            copyMessage(
                x
            )
        );
    }

    // 极保守地合并多行 OCR。
    var merged = [];

    for (var j = 0;
         j < dedup.length;
         j++) {

        var cur =
            dedup[j];

        if (merged.length === 0) {
            merged.push(cur);
            continue;
        }

        var prev =
            merged[
                merged.length - 1
            ];

        var gap =
            cur.top -
            prev.bottom;

        var overlap =
            horizontalOverlapRatio(
                prev,
                cur
            );

        var lineHeight =
            Math.max(
                1,
                Math.min(
                    prev.bottom -
                        prev.top,
                    cur.bottom -
                        cur.top
                )
            );

        if (prev.from ===
                cur.from &&
            gap >= -dp(2) &&
            gap <=
                lineHeight *
                0.38 &&
            overlap >= 0.68 &&
            prev.text.length < 180 &&
            cur.text.length < 180) {

            prev.text +=
                "\n" +
                cur.text;

            prev.left =
                Math.min(
                    prev.left,
                    cur.left
                );

            prev.right =
                Math.max(
                    prev.right,
                    cur.right
                );

            prev.top =
                Math.min(
                    prev.top,
                    cur.top
                );

            prev.bottom =
                Math.max(
                    prev.bottom,
                    cur.bottom
                );

        } else {
            merged.push(cur);
        }
    }

    return merged;
}

function mergeMessages(
    textItems,
    mediaItems
) {
    var all = [];

    for (var i = 0;
         i < textItems.length;
         i++) {

        var t =
            copyMessage(
                textItems[i]
            );

        t.kind = "text";

        all.push(t);
    }

    for (var j = 0;
         j < mediaItems.length;
         j++) {

        var m =
            copyMessage(
                mediaItems[j]
            );

        m.kind = "media";

        all.push(m);
    }

    all.sort(function (a, b) {
        var ay =
            (a.top +
             a.bottom) / 2;

        var by =
            (b.top +
             b.bottom) / 2;

        if (Math.abs(
            ay - by
        ) > dp(4)) {
            return ay - by;
        }

        return a.left -
            b.left;
    });

    var out = [];

    for (var k = 0;
         k < all.length;
         k++) {

        var cur =
            all[k];

        if (cur.kind !==
            "media") {

            out.push(cur);
            continue;
        }

        var duplicate = false;

        for (var p = 0;
             p < out.length;
             p++) {

            var prev =
                out[p];

            if (prev.kind !==
                "media") {
                continue;
            }

            if (rectIoU(
                cur,
                prev
            ) > 0.72) {
                duplicate = true;
                break;
            }
        }

        if (!duplicate) {
            out.push(cur);
        }
    }

    return out;
}

function assignIds(messages) {
    for (var i = 0;
         i < messages.length;
         i++) {

        messages[i].id =
            i + 1;
    }
}

function assignImageRefs(messages) {
    var n = 0;

    for (var i = 0;
         i < messages.length;
         i++) {

        if (messages[i].kind ===
            "media") {

            n++;

            messages[i]
                .imageRef =
                "image_" +
                n;
        }
    }
}

function countMedia(messages) {
    var n = 0;

    for (var i = 0;
         i < messages.length;
         i++) {

        if (messages[i].kind ===
            "media") {
            n++;
        }
    }

    return n;
}

function forEachMedia(
    messages,
    fn
) {
    for (var i = 0;
         i < messages.length;
         i++) {

        if (messages[i].kind ===
            "media") {

            fn(
                messages[i]
            );
        }
    }
}

function copyMessage(x) {
    return {
        kind:
            x.kind || "text",

        from:
            x.from,

        text:
            x.text || "",

        mediaHint:
            x.mediaHint || null,

        captureStatus:
            x.captureStatus || null,

        imageRef:
            x.imageRef || null,

        imageDataUrl:
            x.imageDataUrl || null,

        visualDescription:
            x.visualDescription || null,

        visualTranscript:
            x.visualTranscript || null,

        visualFunction:
            x.visualFunction || null,

        visualTone:
            x.visualTone || null,

        top:
            x.top,

        bottom:
            x.bottom,

        left:
            x.left,

        right:
            x.right,

        confidence:
            x.confidence
    };
}


// ============================================================================
// 13. FILTER / BOUNDS / SIDE
// ============================================================================

function cleanChatText(s) {
    if (s == null) {
        return "";
    }

    s =
        String(s)
            .replace(
                /\u200B/g,
                ""
            )
            .replace(
                /\r/g,
                ""
            )
            .replace(
                /[ \t]+/g,
                " "
            )
            .trim();

    if (!s ||
        s.length > 800) {
        return "";
    }

    if (/^\d{1,2}:\d{2}$/
            .test(s) ||
        /^(上午|下午)?\s*\d{1,2}:\d{2}$/
            .test(s) ||
        /^\d{1,2}\/\d{1,2}(\s+\d{1,2}:\d{2})?$/
            .test(s) ||
        /^(Yesterday|Today|昨天|今天|周一|周二|周三|周四|周五|周六|周日)(\s+\d{1,2}:\d{2})?$/i
            .test(s) ||
        /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(\s+\d{1,2}:\d{2})?$/i
            .test(s) ||
        /^\d{1,2}月\d{1,2}日(\s+\d{1,2}:\d{2})?$/
            .test(s)) {
        return "";
    }

    if (/^(微信|WeChat|QQ|TIM|Telegram|WhatsApp|LINE|Discord|Signal|Messenger|发送|表情|更多|语音|按住说话|按住 说话|聊天信息|返回|返回消息|关闭|搜索|添加|视频通话|语音通话|聊天设置|说点什么|说点什么\.\.\.|Reply|Send|Search|Type a message)$/i
            .test(s)) {
        return "";
    }

    if (/^(Images?|Photos?|Pictures?|Image|Photo|Profile Photo|Avatar|Video|File|图片|照片|头像|视频|文件)$/i
            .test(s)) {
        return "";
    }

    if (/Profile\s*Photo/i
            .test(s)) {
        return "";
    }

    if (/^(群主|管理员|群管理员|楼主|机器人|已读|未读|Owner|Admin|Bot)$/i
            .test(s)) {
        return "";
    }

    if (/^\(\d+\)$/
            .test(s)) {
        return "";
    }

    return s;
}

function isMetaLabel(s) {
    s =
        String(
            s ||
            ""
        ).trim();

    if (!s) {
        return true;
    }

    if (s.length <= 18 &&
        /群主|管理员|已读|未读/.test(s)) {
        return true;
    }

    return false;
}

function itemArea(x) {
    return Math.max(
        1,
        (x.right - x.left) *
        (x.bottom - x.top)
    );
}

function filterMessageItems(items) {
    if (!items ||
        items.length === 0) {
        return [];
    }

    var filtered = [];

    for (var i = 0;
         i < items.length;
         i++) {

        if (!isMetaLabel(
            items[i].text
        )) {
            filtered.push(
                items[i]
            );
        }
    }

    filtered.sort(function (a, b) {
        return itemArea(b) -
            itemArea(a);
    });

    var kept = [];

    for (var j = 0;
         j < filtered.length;
         j++) {

        var cur =
            filtered[j];

        var drop = false;

        for (var k = 0;
             k < kept.length;
             k++) {

            var prev =
                kept[k];

            var sameText =
                prev.text ===
                cur.text;

            var nestedQuote =
                cur.text.length >=
                    10 &&
                prev.text.indexOf(
                    cur.text
                ) >= 0 &&
                prev.text.length >
                    cur.text.length +
                    2;

            if ((sameText ||
                 nestedQuote) &&
                rectIoU(
                    cur,
                    prev
                ) > 0.12) {

                drop = true;
                break;
            }

            if (sameText &&
                itemArea(cur) <
                    itemArea(prev) *
                    0.85) {

                drop = true;
                break;
            }
        }

        if (!drop) {
            kept.push(cur);
        }
    }

    var out = [];

    for (var p = 0;
         p < kept.length;
         p++) {

        var item =
            kept[p];

        var h =
            item.bottom -
            item.top;

        var nickname =
            item.text.length <=
                18 &&
            h <=
                dp(30);

        if (nickname) {
            var aboveBubble =
                false;

            for (var q = 0;
                 q < kept.length;
                 q++) {

                if (q === p) {
                    continue;
                }

                var other =
                    kept[q];

                if (other.top >=
                        item.bottom -
                        dp(8) &&
                    other.top <=
                        item.bottom +
                        dp(52) &&
                    other.text.length >
                        item.text.length &&
                    (other.right -
                     other.left) >
                        (item.right -
                         item.left) *
                        1.1) {

                    aboveBubble =
                        true;
                    break;
                }
            }

            if (aboveBubble) {
                continue;
            }
        }

        out.push(item);
    }

    out.sort(function (a, b) {
        if (Math.abs(
            a.top - b.top
        ) > dp(3)) {
            return a.top -
                b.top;
        }

        return a.left -
            b.left;
    });

    return out;
}

function isPlausibleBounds(
    b,
    topY,
    bottomY
) {
    if (!b) {
        return false;
    }

    if (b.bottom <= topY ||
        b.top >= bottomY) {
        return false;
    }

    if (b.right <= 0 ||
        b.left >= SCREEN_W) {
        return false;
    }

    var w =
        b.right -
        b.left;

    var h =
        b.bottom -
        b.top;

    if (w < dp(3) ||
        h < dp(7)) {
        return false;
    }

    if (w >
        SCREEN_W * 0.98) {
        return false;
    }

    if (h >
        SCREEN_H * 0.48) {
        return false;
    }

    return true;
}

function sideFromBounds(
    b,
    profile
) {
    var leftGap =
        Math.max(
            0,
            b.left
        );

    var rightGap =
        Math.max(
            0,
            SCREEN_W -
            b.right
        );

    var geometric;

    if (leftGap <
            SCREEN_W * 0.22 &&
        rightGap >
            leftGap +
            dp(8)) {
        geometric = "left";
    } else if (
        rightGap <
            SCREEN_W * 0.22 &&
        leftGap >
            rightGap +
            dp(8)
    ) {
        geometric = "right";
    } else if (
        leftGap <=
        rightGap
    ) {
        geometric = "left";
    } else {
        geometric = "right";
    }

    if (profile &&
        profile.outgoingSide ===
        "left") {

        return geometric ===
            "left"
            ? "me"
            : "other";
    }

    return geometric ===
        "right"
        ? "me"
        : "other";
}

function horizontalOverlapRatio(
    a,
    b
) {
    var left =
        Math.max(
            a.left,
            b.left
        );

    var right =
        Math.min(
            a.right,
            b.right
        );

    var overlap =
        Math.max(
            0,
            right - left
        );

    var minWidth =
        Math.max(
            1,
            Math.min(
                a.right -
                    a.left,
                b.right -
                    b.left
            )
        );

    return overlap /
        minWidth;
}

function rectIoU(a, b) {
    var l =
        Math.max(
            a.left,
            b.left
        );

    var t =
        Math.max(
            a.top,
            b.top
        );

    var r =
        Math.min(
            a.right,
            b.right
        );

    var bot =
        Math.min(
            a.bottom,
            b.bottom
        );

    var iw =
        Math.max(
            0,
            r - l
        );

    var ih =
        Math.max(
            0,
            bot - t
        );

    var inter =
        iw * ih;

    var areaA =
        Math.max(
            1,
            (a.right -
             a.left) *
            (a.bottom -
             a.top)
        );

    var areaB =
        Math.max(
            1,
            (b.right -
             b.left) *
            (b.bottom -
             b.top)
        );

    return inter /
        Math.max(
            1,
            areaA +
            areaB -
            inter
        );
}


// ============================================================================
// 14. TARGETS + CARD LAYOUT
// ============================================================================

function chooseTargets(capture) {
    var others = [];

    for (var i = 0;
         i < capture.messages.length;
         i++) {

        var m =
            capture.messages[i];

        m.target = false;
        m.card = null;

        if (m.from === "other") {
            others.push(m);
        }
    }

    var start =
        Math.max(
            0,
            others.length -
            CONFIG.maxAnalyzedOther
        );

    var selected =
        others.slice(start);

    for (var j = 0;
         j < selected.length;
         j++) {

        selected[j].target =
            true;
    }
}

function countTargets(capture) {
    var n = 0;

    for (var i = 0;
         i < capture.messages.length;
         i++) {

        if (capture.messages[i]
            .target) {
            n++;
        }
    }

    return n;
}

function computeCardLayout(capture) {
    var cardW =
        Math.min(
            Math.round(
                SCREEN_W * 0.52
            ),
            dp(252)
        );

    var gap =
        dp(6);

    var minY =
        chatTop(
            currentProfile
        );

    var maxBottom =
        chatBottom(
            currentProfile
        );

    var occupied = [];

    for (var i = 0;
         i < capture.messages.length;
         i++) {

        var m =
            capture.messages[i];

        if (!m.target) {
            continue;
        }

        var optionCount =
            3;

        var hyp =
            currentHypotheses[
                String(
                    m.id
                )
            ];

        if (hyp &&
            hyp.options &&
            hyp.options.length) {
            optionCount =
                Math.min(
                    4,
                    Math.max(
                        2,
                        hyp.options.length
                    )
                );
        }

        var cardH =
            dp(22) +
            dp(16) +
            optionCount *
                dp(15) +
            dp(22);

        var maxY =
            maxBottom -
            cardH;

        var x;

        if (currentProfile
            .outgoingSide ===
            "right") {

            x =
                Math.max(
                    m.right +
                        dp(10),
                    Math.round(
                        SCREEN_W *
                        0.48
                    )
                );

            x =
                Math.min(
                    x,
                    SCREEN_W -
                    cardW -
                    dp(6)
                );

        } else {
            x =
                Math.min(
                    m.left -
                        cardW -
                        dp(10),
                    Math.round(
                        SCREEN_W *
                        0.05
                    )
                );

            x =
                Math.max(
                    dp(6),
                    x
                );
        }

        var centerY =
            (m.top +
             m.bottom) / 2;

        var y =
            clamp(
                Math.round(
                    centerY -
                    cardH / 2
                ),
                minY,
                maxY
            );

        for (var k = 0;
             k < occupied.length;
             k++) {

            var o =
                occupied[k];

            if (rectsOverlap(
                x,
                y,
                cardW,
                cardH,
                o.x,
                o.y,
                o.w,
                o.h
            )) {
                y =
                    clamp(
                        o.y +
                        o.h +
                        gap,
                        minY,
                        maxY
                    );
            }
        }

        m.card = {
            x: x,
            y: y,
            w: cardW,
            h: cardH
        };

        occupied.push(
            m.card
        );
    }
}

function rectsOverlap(
    x1,
    y1,
    w1,
    h1,
    x2,
    y2,
    w2,
    h2
) {
    return !(
        x1 + w1 < x2 ||
        x2 + w2 < x1 ||
        y1 + h1 < y2 ||
        y2 + h2 < y1
    );
}


// ============================================================================
// 15. DRAW
// ============================================================================

function drawOverlay(
    canvas,
    capture
) {
    if (!capture ||
        !capture.messages) {
        return;
    }

    var messages =
        capture.messages;

    for (var i = 0;
         i < messages.length;
         i++) {

        var m =
            messages[i];

        if (m.from === "me" &&
            !CONFIG.drawMyMessages) {
            continue;
        }

        drawMessageBox(
            canvas,
            m
        );
    }

    for (var j = 0;
         j < messages.length;
         j++) {

        var target =
            messages[j];

        if (!target.target ||
            !target.card) {
            continue;
        }

        drawTargetCard(
            canvas,
            target
        );
    }

    drawDebugHeader(
        canvas,
        capture
    );
}

function drawMessageBox(
    canvas,
    m
) {
    var other =
        m.from === "other";

    var stroke =
        other
            ? "#F1A846"
            : "#4DCFC3";

    if (m.kind ===
        "media" &&
        m.captureStatus &&
        m.captureStatus !== "ok") {

        stroke =
            "#E07373";
    }

    var fill =
        other
            ? "#16F1A846"
            : "#164DCFC3";

    var pad =
        dp(5);

    var l =
        ox(
            clamp(
                m.left -
                pad,
                0,
                SCREEN_W
            )
        );

    var t =
        oy(
            clamp(
                m.top -
                pad,
                0,
                SCREEN_H
            )
        );

    var r =
        ox(
            clamp(
                m.right +
                pad,
                0,
                SCREEN_W
            )
        );

    var b =
        oy(
            clamp(
                m.bottom +
                pad,
                0,
                SCREEN_H
            )
        );

    paint.setStyle(
        Paint.Style.FILL
    );

    colors.setPaintColor(
        paint,
        fill
    );

    canvas.drawRoundRect(
        l,
        t,
        r,
        b,
        dp(7),
        dp(7),
        paint
    );

    paint.setStyle(
        Paint.Style.STROKE
    );

    paint.setStrokeWidth(
        dp(1.3)
    );

    colors.setPaintColor(
        paint,
        stroke
    );

    canvas.drawRoundRect(
        l,
        t,
        r,
        b,
        dp(7),
        dp(7),
        paint
    );

    paint.setStyle(
        Paint.Style.FILL
    );

    paint.setTextSize(
        dp(9.5)
    );

    colors.setPaintColor(
        paint,
        stroke
    );

    var kind =
        m.kind === "media"
            ? "IMG"
            : "TXT";

    var source =
        currentCapture.source;

    var status = "";

    if (m.kind ===
        "media") {

        if (m.captureStatus ===
            "ok") {
            status = " VISION";
        } else if (
            m.captureStatus ===
            "protected_or_blank"
        ) {
            status = " PROTECTED";
        }
    }

    canvas.drawText(
        "#" +
        m.id +
        " " +
        (other
            ? "OTHER"
            : "ME") +
        " " +
        kind +
        " ✓ " +
        source +
        status,
        l,
        Math.max(
            dp(14),
            t -
            dp(3)
        ),
        paint
    );

    if (CONFIG.drawRecognizedText) {
        var debugText;

        if (m.kind ===
            "media") {

            debugText =
                m.visualTranscript ||
                m.visualDescription ||
                (
                    m.captureStatus ===
                    "protected_or_blank"
                        ? "[图片无法截取/受保护]"
                        : (
                            looksLikeClassName(
                                m.mediaHint
                            )
                                ? "[图片/表情包]"
                                : (
                                    m.mediaHint ||
                                    "[图片/表情包]"
                                )
                        )
                );

        } else {
            debugText =
                m.text;
        }

        paint.setTextSize(
            dp(8.5)
        );

        colors.setPaintColor(
            paint,
            "#CBD1D8"
        );

        canvas.drawText(
            truncate(
                singleLine(
                    debugText
                ),
                28
            ),
            l,
            Math.min(
                SCREEN_H -
                dp(3),
                b +
                dp(11)
            ),
            paint
        );
    }
}

function drawTargetCard(
    canvas,
    m
) {
    var card =
        m.card;

    var x =
        ox(
            card.x
        );

    var y =
        oy(
            card.y
        );

    var w =
        card.w;

    var h =
        card.h;

    // connection line
    paint.setStyle(
        Paint.Style.STROKE
    );

    paint.setStrokeWidth(
        dp(1)
    );

    colors.setPaintColor(
        paint,
        "#77E4A74A"
    );

    var startX =
        ox(
            m.right +
            dp(4)
        );

    var startY =
        oy(
            (m.top +
             m.bottom) / 2
        );

    var endX =
        x;

    var endY =
        y +
        h / 2;

    canvas.drawLine(
        startX,
        startY,
        endX,
        endY,
        paint
    );

    // card bg
    paint.setStyle(
        Paint.Style.FILL
    );

    colors.setPaintColor(
        paint,
        "#EA171A20"
    );

    canvas.drawRoundRect(
        x,
        y,
        x + w,
        y + h,
        dp(8),
        dp(8),
        paint
    );

    paint.setStyle(
        Paint.Style.STROKE
    );

    paint.setStrokeWidth(
        dp(1)
    );

    colors.setPaintColor(
        paint,
        "#AA5E6672"
    );

    canvas.drawRoundRect(
        x,
        y,
        x + w,
        y + h,
        dp(8),
        dp(8),
        paint
    );

    // header
    paint.setStyle(
        Paint.Style.FILL
    );

    paint.setTextSize(
        dp(9.5)
    );

    colors.setPaintColor(
        paint,
        "#FFC76A"
    );

    canvas.drawText(
        "#" +
        m.id +
        " Jev" +
        (
            m.kind ===
            "media"
                ? " IMG"
                : ""
        ),
        x +
        dp(7),
        y +
        dp(14),
        paint
    );

    var hyp =
        currentHypotheses[
            String(
                m.id
            )
        ];

    var analysis =
        currentAnalyses[
            String(
                m.id
            )
        ];

    var reply =
        currentReplies[
            String(
                m.id
            )
        ];

    var lines =
        buildJevCardLines(
            m,
            hyp,
            analysis,
            reply
        );

    var textY =
        y +
        dp(29);

    for (var li = 0;
         li < lines.length;
         li++) {

        var line =
            lines[li];

        paint.setTextSize(
            line.size ||
            dp(9)
        );

        colors.setPaintColor(
            paint,
            line.color ||
            "#EEF1F4"
        );

        canvas.drawText(
            truncate(
                line.text,
                line.max ||
                32
            ),
            x +
            dp(7),
            textY,
            paint
        );

        textY +=
            line.gap ||
            dp(14);
    }
}

function buildJevCardLines(
    m,
    hyp,
    analysis,
    reply
) {
    var lines = [];

    if (hyp &&
        hyp.hook) {
        lines.push({
            text:
                hyp.hook,
            color:
                "#EEF1F4",
            size:
                dp(9),
            max: 28,
            gap:
                dp(15)
        });
    } else if (
        m.kind === "media" &&
        m.captureStatus ===
            "protected_or_blank"
    ) {
        lines.push({
            text:
                "图片无法读取",
            color:
                "#E07373",
            size:
                dp(9),
            max: 28,
            gap:
                dp(15)
        });
    } else if (
        !analysis
    ) {
        lines.push({
            text:
                "Jev 打分中…",
            color:
                "#D6DAE0",
            size:
                dp(9),
            max: 28,
            gap:
                dp(15)
        });
    }

    var options =
        rankedJevOptions(
            hyp,
            analysis
        );

    if (options.length === 0 &&
        analysis &&
        analysis.intent &&
        analysis.intent.probabilities) {

        var probs =
            analysis.intent
                .probabilities;

        var pkeys =
            Object.keys(
                probs
            );

        pkeys.sort(function (a, b) {
            return (probs[b] || 0) -
                (probs[a] || 0);
        });

        for (var pi = 0;
             pi < pkeys.length &&
             pi < 4;
             pi++) {

            options.push({
                label:
                    intentZh({
                        choice:
                            pkeys[pi]
                    }),
                pct:
                    Math.round(
                        (probs[
                            pkeys[pi]
                        ] || 0) *
                        100
                    ),
                p:
                    probs[
                        pkeys[pi]
                    ] || 0
            });
        }
    } else if (
        options.length === 0 &&
        analysis &&
        analysis.intent
    ) {

        var intentKey =
            choiceValue(
                analysis.intent
            );

        if (intentKey) {
            options = [{
                label:
                    intentZh(
                        analysis.intent
                    ),
                pct:
                    probabilityPct(
                        analysis.intent,
                        intentKey
                    )
            }];
        }
    }

    for (var i = 0;
         i < options.length &&
         i < 4;
         i++) {

        var opt =
            options[i];

        lines.push({
            text:
                "- " +
                opt.label +
                "：" +
                opt.pct +
                "%",
            color:
                i === 0
                    ? "#FFC76A"
                    : "#D6DAE0",
            size:
                dp(8.8),
            max: 30,
            gap:
                dp(14)
        });
    }

    if (reply) {
        lines.push({
            text:
                "建议动作：" +
                reply,
            color:
                "#9CE2D5",
            size:
                dp(8.6),
            max: 32,
            gap:
                dp(13)
        });
    } else if (
        analysis
    ) {
        lines.push({
            text:
                "建议动作生成中…",
            color:
                "#9CE2D5",
            size:
                dp(8.6),
            max: 32,
            gap:
                dp(13)
        });
    }

    return lines;
}

function rankedJevOptions(
    hyp,
    analysis
) {
    var out = [];

    if (!analysis ||
        !analysis.reading) {
        if (hyp &&
            hyp.options) {
            for (var h = 0;
                 h < hyp.options.length;
                 h++) {
                out.push({
                    label:
                        hyp.options[h]
                            .label,
                    pct: "…"
                });
            }
        }

        return out;
    }

    var reading =
        analysis.reading;

    var probs =
        reading.probabilities ||
        {};

    if (hyp &&
        hyp.options &&
        hyp.options.length) {

        for (var i = 0;
             i < hyp.options.length;
             i++) {

            var option =
                hyp.options[i];

            var key =
                option.key;

            var p =
                0;

            if (typeof probs[key] ===
                "number") {
                p =
                    probs[key];
            } else if (
                reading.choice ===
                key
            ) {
                p = 1;
            }

            out.push({
                label:
                    option.label,
                pct:
                    Math.round(
                        p * 100
                    ),
                p: p
            });
        }

    } else if (
        Object.keys(probs).length
    ) {

        var keys =
            Object.keys(
                probs
            );

        for (var k = 0;
             k < keys.length;
             k++) {

            out.push({
                label:
                    keys[k],
                pct:
                    Math.round(
                        probs[
                            keys[k]
                        ] * 100
                    ),
                p:
                    probs[
                        keys[k]
                    ]
            });
        }
    }

    out.sort(function (a, b) {
        return (b.p || 0) -
            (a.p || 0);
    });

    return out;
}

function probabilityPct(answer, key) {
    if (!answer ||
        !answer.probabilities) {
        return "?";
    }

    var p =
        answer.probabilities[key];

    if (typeof p !==
        "number") {
        return "?";
    }

    return Math.round(
        p * 100
    );
}

function drawDebugHeader(
    canvas,
    capture
) {
    if (!capture) {
        return;
    }

    paint.setStyle(
        Paint.Style.FILL
    );

    paint.setTextSize(
        dp(8.5)
    );

    colors.setPaintColor(
        paint,
        "#9AA3AE"
    );

    var s =
        capture.appName +
        " · " +
        capture.source +
        " · " +
        (capture.viewportVia ||
            "") +
        " · msg=" +
        capture.messages.length +
        " · media=" +
        capture.readableMediaCount +
        "/" +
        capture.mediaCount;

    if (currentGlobalJev &&
        typeof currentGlobalJev.rewrite ===
            "number" &&
        currentGlobalJev.rewrite >=
            0.35) {
        s +=
            " · " +
            (currentGlobalJev.label ||
                "附加要求") +
            "：" +
            Math.round(
                currentGlobalJev.rewrite *
                100
            ) +
            "%";
    }

    if (currentGlobalJev &&
        typeof currentGlobalJev.danger ===
            "number" &&
        currentGlobalJev.danger >= 4) {
        s +=
            " · 压力 " +
            currentGlobalJev.danger
                .toFixed(0) +
            "/10";
    }

    canvas.drawText(
        truncate(
            s,
            76
        ),
        dp(7),
        dp(15),
        paint
    );
}

function drawEllipsizedLines(
    canvas,
    text,
    x,
    baselineY,
    maxWidth,
    maxLines,
    p
) {
    text =
        String(
            text || ""
        );

    var remaining =
        text;

    var y =
        baselineY;

    for (var line = 0;
         line < maxLines &&
         remaining.length > 0;
         line++) {

        var cut =
            remaining.length;

        while (cut > 1 &&
               p.measureText(
                   remaining.substring(
                       0,
                       cut
                   )
               ) >
               maxWidth) {
            cut--;
        }

        var part =
            remaining.substring(
                0,
                cut
            );

        remaining =
            remaining.substring(
                cut
            );

        if (line ===
                maxLines - 1 &&
            remaining.length > 0) {

            while (
                part.length > 1 &&
                p.measureText(
                    part + "…"
                ) >
                maxWidth
            ) {
                part =
                    part.substring(
                        0,
                        part.length - 1
                    );
            }

            part += "…";
        }

        canvas.drawText(
            part,
            x,
            y,
            p
        );

        y +=
            dp(11);
    }
}


// ============================================================================
// 16. DEEPSEEK VISION
// ============================================================================

function understandMediaWithDeepSeek(
    capture
) {
    var media = [];

    for (var i = 0;
         i < capture.messages.length;
         i++) {

        var m =
            capture.messages[i];

        if (m.kind === "media" &&
            m.imageDataUrl &&
            m.captureStatus === "ok") {

            media.push(m);
        }
    }

    if (media.length === 0) {
        return {};
    }

    var system =
        "你在看聊天消息里的原图，不是手机界面，也不是标注框。" +
        "表情包经常是低分辨率像素图，那就是内容本身，禁止写成模糊、空白、卡顿、截图失败、黄格。" +
        "description 要足够具体，让人能判断这张图是在得意、拒绝、附和、无语，还是在转述别的对话。" +
        "截图里的对话按原话写入 transcript，不要概括成「一张截图」。没有文字则 transcript 为空字符串。" +
        "id 必须等于我给出的 message 编号，禁止从 1 重新编号。" +
        "image_ref 原样抄回。" +
        "只输出 JSON：" +
        "{\"items\":[{\"id\":6,\"image_ref\":\"image_2\",\"transcript\":\"\",\"description\":\"黄色方块脸，眯眼吐舌，得意\",\"function\":\"嘲讽\",\"tone\":\"得意\"}]}。";

    var parts = [
        {
            type: "text",
            text:
                "关系描述：" +
                CONFIG.relationship +
                "\n下面每张图都对应一条聊天消息。"
        }
    ];

    for (var j = 0;
         j < media.length;
         j++) {

        var mm =
            media[j];

        parts.push({
            type: "text",
            text:
                mm.imageRef +
                " = message #" +
                mm.id +
                " from " +
                mm.from
        });

        parts.push({
            type: "image_url",
            image_url: {
                url:
                    mm.imageDataUrl,
                detail:
                    CONFIG.multimodal
                        .detail
            }
        });
    }

    var body = {
        model:
            CONFIG.LLM.model,

        messages: [
            {
                role: "system",
                content: system
            },
            {
                role: "user",
                content: parts
            }
        ],

        thinking: {
            type: "disabled"
        },

        response_format: {
            type: "json_object"
        },

        temperature: 0.2,
        max_tokens: 1000,
        stream: false
    };

    var json =
        postJson(
            CONFIG.LLM.endpoint,
            body,
            CONFIG.LLM.apiKey
        );

    var content =
        extractAssistantContent(
            json,
            "DeepSeek Vision"
        );

    var parsed =
        parseJsonStrict(
            content,
            "DeepSeek Vision"
        );

    var out = {
        _order: []
    };

    if (parsed &&
        Array.isArray(
            parsed.items
        )) {

        for (var k = 0;
             k < parsed.items.length;
             k++) {

            var v =
                parsed.items[k];

            if (!v ||
                v.id == null) {
                continue;
            }

            var entry = {
                imageRef:
                    String(
                        v.image_ref ||
                        v.imageRef ||
                        ""
                    ).trim(),

                transcript:
                    String(
                        v.transcript ||
                        ""
                    ).trim(),

                description:
                    String(
                        v.description ||
                        ""
                    ).trim(),

                function:
                    String(
                        v.function ||
                        ""
                    ).trim(),

                tone:
                    String(
                        v.tone ||
                        ""
                    ).trim()
            };

            out[
                String(v.id)
            ] = entry;

            out._order.push(
                entry
            );
        }
    }

    debugLog(
        "VISION",
        JSON.stringify(
            out,
            null,
            2
        )
    );

    return out;
}

function applyVisualUnderstanding(
    capture,
    visual
) {
    var media = [];

    for (var i = 0;
         i < capture.messages.length;
         i++) {

        if (capture.messages[i]
            .kind === "media" &&
            capture.messages[i]
                .captureStatus ===
                "ok") {

            media.push(
                capture.messages[i]
            );
        }
    }

    var values =
        visual &&
        visual._order
            ? visual._order
            : [];

    var keys = [];
    var rawKeys =
        Object.keys(
            visual || {}
        );

    for (var k = 0;
         k < rawKeys.length;
         k++) {

        if (rawKeys[k] ===
            "_order") {
            continue;
        }

        keys.push(
            rawKeys[k]
        );

        if (!values.length) {
            values.push(
                visual[
                    rawKeys[k]
                ]
            );
        }
    }

    var idSet = {};

    for (var a = 0;
         a < media.length;
         a++) {
        idSet[
            String(media[a].id)
        ] = true;
    }

    var idsMatch =
        keys.length ===
            media.length &&
        keys.length > 0;

    for (var b = 0;
         b < keys.length;
         b++) {

        if (!idSet[keys[b]]) {
            idsMatch = false;
            break;
        }
    }

    if (idsMatch) {
        for (var c = 0;
             c < media.length;
             c++) {

            writeVisual(
                media[c],
                visual[
                    String(
                        media[c].id
                    )
                ]
            );
        }

        return;
    }

    var byRef = {};

    for (var d = 0;
         d < values.length;
         d++) {

        if (values[d] &&
            values[d].imageRef) {

            byRef[
                values[d].imageRef
            ] =
                values[d];
        }
    }

    var refHits = 0;

    for (var e = 0;
         e < media.length;
         e++) {

        if (byRef[
            media[e].imageRef
        ]) {
            refHits++;
        }
    }

    if (refHits ===
        media.length &&
        media.length > 0) {

        for (var f = 0;
             f < media.length;
             f++) {

            writeVisual(
                media[f],
                byRef[
                    media[f]
                        .imageRef
                ]
            );
        }

        return;
    }

    var n =
        Math.min(
            media.length,
            values.length
        );

    for (var g = 0; g < n; g++) {
        writeVisual(
            media[g],
            values[g]
        );
    }
}

function writeVisual(m, v) {
    var transcript =
        stripVisionNoise(
            v.transcript
        );

    var description =
        stripVisionNoise(
            v.description
        );

    m.visualTranscript =
        transcript ||
        null;

    m.visualDescription =
        description ||
        transcript ||
        null;

    m.visualFunction =
        v.function ||
        null;

    m.visualTone =
        v.tone ||
        null;
}

function stripVisionNoise(s) {
    s =
        String(
            s || ""
        ).trim();

    if (!s) {
        return "";
    }

    if (/^image_\d+$/i
            .test(s) ||
        /^(图片|表情包|空白|模糊)$/
            .test(s)) {
        return "";
    }

    return s;
}


// ============================================================================
// 17. SEMANTIC CONTEXT
// ============================================================================

function semanticTextForMessage(m) {
    if (!m) {
        return "";
    }

    if (m.kind !==
        "media") {
        return m.text || "";
    }

    if (m.captureStatus ===
        "protected_or_blank") {

        return "[图片/表情包：设备截图得到空白或受保护内容，视觉语义未知]";
    }

    var s =
        "[图片/表情包]";

    if (m.visualTranscript) {
        s +=
            " 图内文字：" +
            m.visualTranscript;
    }

    if (m.visualDescription &&
        m.visualDescription !==
            m.visualTranscript) {
        s +=
            " 画面：" +
            m.visualDescription;
    } else if (
        !m.visualTranscript &&
        m.visualDescription
    ) {
        s +=
            " 画面：" +
            m.visualDescription;
    } else if (
        !m.visualTranscript &&
        !m.visualDescription
    ) {
        s +=
            " 画面未读出";
    }

    if (m.visualFunction) {
        s +=
            "；沟通功能：" +
            m.visualFunction;
    }

    if (m.visualTone) {
        s +=
            "；语气：" +
            m.visualTone;
    }

    return s;
}

function semanticHistoryItem(m) {
    return {
        from:
            m.from,

        kind:
            m.kind ||
            "text",

        text:
            semanticTextForMessage(
                m
            ),

        image_ref:
            m.kind === "media"
                ? (
                    m.imageRef ||
                    null
                )
                : null
    };
}


// ============================================================================
// 18. HYPOTHESES + JEV + ACTION
// ============================================================================

function extractHypotheses(capture) {
    var items = [];
    var messages =
        capture.messages;

    for (var i = 0;
         i < messages.length;
         i++) {

        var m =
            messages[i];

        if (!m.target) {
            continue;
        }

        var history = [];
        var start =
            Math.max(
                0,
                i - 10
            );

        for (var j = start;
             j <= i;
             j++) {

            history.push(
                semanticHistoryItem(
                    messages[j]
                )
            );
        }

        items.push({
            id:
                m.id,

            target_kind:
                m.kind,

            target:
                semanticTextForMessage(
                    m
                ),

            context_up_to_target:
                history
        });
    }

    if (items.length === 0) {
        return {};
    }

    var system =
        "你给 Jev 准备互斥假说。Jev 只会给这些选项打百分比，不会改写它们。" +
        "每条对方消息：一个问题，加 2 到 4 个短选项。选项必须互斥，而且都能从这句话或上文里指出来。\n" +
        "先看这句话是哪一类，再出题，禁止套错模板：\n" +
        "1. 闲聊、约局、复读、表情包：问它是在确认、改口、调侃还是敷衍。不要写成需求膨胀或职场陷阱。\n" +
        "2. 表情包用输入里的「画面」。选项写沟通功能，例如得意、缓和拒绝、附和、不知道怎么回。不要描述像素清不清。\n" +
        "3. 只有对方在谈范围、截止时间、钱、帮忙、加功能时，才拆成「字面好说话 / 实际加活」。这类例子不要用到闲聊上：\n" +
        "「简单点」→ 功能简单 / 预算简单；「顺便加个 AI」→ 属于需求 / 只是随口；「明天能上线吧」→ 正常开发 / 连夜赶工 / 只要演示版。\n" +
        "hook 引用原文里真正含糊的那几个字。没有滑词就不要硬找。\n" +
        "label 用 2 到 8 个汉字。rubric 用一句英文说明何时选它。key 只用 a/b/c/d。\n" +
        "id 必须等于输入里的 message id，不要从 1 重新编号。\n" +
        "禁止放之四海的空选项：字面意思、另有要求、在试探、其他。\n" +
        "只输出 JSON：" +
        "{\"items\":[{\"id\":6,\"hook\":\"\\\"还是六局\\\"是在确认还是改期？\",\"options\":[{\"key\":\"a\",\"label\":\"确认延期\",\"rubric\":\"They are confirming a postponement.\"},{\"key\":\"b\",\"label\":\"只是复读\",\"rubric\":\"They are echoing the previous line.\"},{\"key\":\"c\",\"label\":\"改期六局\",\"rubric\":\"They want to move it to six games.\"}]}]}";

    var body = {
        model:
            CONFIG.LLM.model,

        messages: [
            {
                role: "system",
                content: system
            },
            {
                role: "user",
                content:
                    JSON.stringify({
                        relationship:
                            CONFIG.relationship,

                        app:
                            capture.appName,

                        items:
                            items
                    })
            }
        ],

        thinking: {
            type: "disabled"
        },

        response_format: {
            type: "json_object"
        },

        temperature: 0.35,
        max_tokens: 2400,
        stream: false
    };

    var json =
        postJson(
            CONFIG.LLM.endpoint,
            body,
            CONFIG.LLM.apiKey
        );

    var content =
        extractAssistantContent(
            json,
            "Hypotheses"
        );

    var parsed =
        parseJsonStrict(
            content,
            "Hypotheses"
        );

    var parsedItems = [];

    var rawItems =
        parsed &&
        (
            parsed.items ||
            parsed.hypotheses ||
            parsed.results
        );

    if (Array.isArray(rawItems)) {
        for (var k = 0;
             k < rawItems.length;
             k++) {

            var norm =
                normalizeHypothesis(
                    rawItems[k]
                );

            if (norm) {
                parsedItems.push(
                    norm
                );
            }
        }
    }

    var aligned =
        alignHypotheses(
            parsedItems,
            items
        );

    var out = {
        _globalLabel:
            (parsed &&
             parsed.global_label)
                ? String(
                    parsed.global_label
                ).trim()
                : "附加要求"
    };

    var ids =
        Object.keys(
            aligned
        );

    for (var n = 0;
         n < ids.length;
         n++) {
        out[ids[n]] =
            aligned[ids[n]];
    }

    if (ids.length === 0) {
        for (var f = 0;
             f < items.length;
             f++) {

            out[
                String(
                    items[f].id
                )
            ] =
                fallbackHypothesis(
                    items[f].target
                );
        }
    }

    debugLog(
        "HYPOTHESES",
        JSON.stringify(
            out,
            null,
            2
        )
    );

    return out;
}

function normalizeHypothesis(it) {
    if (!it) {
        return null;
    }

    var hook =
        it.hook ||
        it.question ||
        it.prompt ||
        "";

    var options =
        coerceOptions(
            it.options ||
            it.hypotheses ||
            it.choices
        );

    if (!hook ||
        options.length < 2) {
        return null;
    }

    return {
        id:
            it.id,

        hook:
            String(hook).trim(),

        options:
            options
    };
}

function coerceOptions(raw) {
    var list = raw;

    if (typeof list ===
        "string") {
        list =
            list.split(
                /[/|、\n]/
            );
    }

    if (list &&
        !Array.isArray(list) &&
        typeof list ===
            "object") {

        var keys =
            Object.keys(list);

        var mapped = [];

        for (var i = 0;
             i < keys.length;
             i++) {

            mapped.push({
                key:
                    keys[i],
                label:
                    list[keys[i]]
            });
        }

        list = mapped;
    }

    if (!Array.isArray(list)) {
        return [];
    }

    var options = [];
    var letters = [
        "a",
        "b",
        "c",
        "d"
    ];

    for (var o = 0;
         o < list.length &&
         options.length < 4;
         o++) {

        var op =
            list[o];

        var label = "";
        var key = "";
        var rubric = "";

        if (typeof op ===
            "string") {
            label = op;
        } else if (op) {
            label =
                op.label ||
                op.text ||
                op.name ||
                op.option ||
                "";

            key =
                op.key ||
                op.id ||
                "";

            rubric =
                op.rubric ||
                op.description ||
                label;
        }

        label =
            String(
                label || ""
            ).trim();

        if (!label) {
            continue;
        }

        options.push({
            key:
                String(
                    key ||
                    letters[
                        options.length
                    ]
                ),

            label:
                label,

            rubric:
                String(
                    rubric ||
                    label
                ).trim()
        });
    }

    return options;
}

function alignHypotheses(
    parsedItems,
    targets
) {
    var out = {};
    var byId = {};

    for (var i = 0;
         i < parsedItems.length;
         i++) {

        if (parsedItems[i].id !=
            null) {
            byId[
                String(
                    parsedItems[i].id
                )
            ] =
                parsedItems[i];
        }
    }

    var hits = 0;

    for (var t = 0;
         t < targets.length;
         t++) {

        if (byId[
            String(
                targets[t].id
            )
        ]) {
            hits++;
        }
    }

    if (hits > 0 &&
        hits >=
            Math.ceil(
                targets.length /
                2
            )) {

        for (var u = 0;
             u < targets.length;
             u++) {

            var hit =
                byId[
                    String(
                        targets[u].id
                    )
                ];

            if (hit) {
                out[
                    String(
                        targets[u].id
                    )
                ] = {
                    hook:
                        hit.hook,
                    options:
                        hit.options
                };
            }
        }

        return out;
    }

    var n =
        Math.min(
            parsedItems.length,
            targets.length
        );

    for (var k = 0;
         k < n;
         k++) {

        out[
            String(
                targets[k].id
            )
        ] = {
            hook:
                parsedItems[k].hook,
            options:
                parsedItems[k].options
        };
    }

    return out;
}

function fallbackHypothesis(text) {
    var clip =
        truncate(
            singleLine(
                text || ""
            ),
            12
        );

    return {
        hook:
            clip
                ? "「" +
                  clip +
                  "」实际在说什么？"
                : "这句话实际在说什么？",

        options: [
            {
                key: "a",
                label: "字面意思",
                rubric:
                    "The literal reading is what they mean."
            },
            {
                key: "b",
                label: "另有要求",
                rubric:
                    "There is a practical ask, scope change, or hidden request."
            },
            {
                key: "c",
                label: "在试探",
                rubric:
                    "They are testing the user's reaction or commitment."
            }
        ]
    };
}

function attachHypotheses(
    capture,
    hypotheses
) {
    for (var i = 0;
         i < capture.messages.length;
         i++) {

        var m =
            capture.messages[i];

        if (!m.target) {
            continue;
        }

        m.hypothesis =
            hypotheses[
                String(
                    m.id
                )
            ] ||
            null;
    }
}

function analyzeWithJev(
    capture,
    hypotheses
) {
    var targets =
        buildJevTargets(
            capture
        );

    var keys =
        Object.keys(
            targets
        );

    if (keys.length === 0) {
        return {};
    }

    var questions = {};

    for (var i = 0;
         i < keys.length;
         i++) {

        var key =
            keys[i];

        var id =
            key.replace(
                /^m/,
                ""
            );

        var hyp =
            hypotheses[
                id
            ];

        if (hyp &&
            hyp.options &&
            hyp.options.length >= 2) {

            var criteria = {};

            for (var o = 0;
                 o < hyp.options.length;
                 o++) {

                criteria[
                    hyp.options[o].key
                ] =
                    hyp.options[o].label +
                    ". " +
                    hyp.options[o].rubric;
            }

            questions[
                key +
                "_reading"
            ] = {
                type: "choice",

                instructions:
                    "Target " +
                    key +
                    ". Question: " +
                    hyp.hook +
                    " Choose the option the words and prior turns actually support. Ordinary chat, jokes, and stickers may be literal or playful; that is a valid answer. Do not upgrade mild talk into conflict, hidden demands, or extra work. If the evidence is thin, keep probability spread across the real options. Use only context_up_to_target.",

                criteria:
                    criteria
            };

        } else {

            questions[
                key +
                "_intent"
            ] = {
                type: "choice",

                instructions:
                    "For target " +
                    key +
                    ", what is the sender actually doing? Prefer pragmatic intent. Do not invent conflict when ordinary conversation is sufficient.",

                criteria: {
                    ask_information:
                        "Asking for information or clarification.",

                    ask_action:
                        "Requesting the user to do something or commit.",

                    agree_or_confirm:
                        "Agreeing, confirming, or acknowledging.",

                    praise_or_positive_reaction:
                        "Praising or reacting positively.",

                    joke_or_tease:
                        "Joking, meme-like banter, or teasing.",

                    share_information:
                        "Sharing an update, image, or fact.",

                    express_opinion:
                        "Giving an opinion or evaluation.",

                    complain_or_object:
                        "Objecting, criticizing, or showing dissatisfaction.",

                    reassure_or_support:
                        "Reassuring or supporting.",

                    close_topic:
                        "Wrapping up without an outstanding request.",

                    other:
                        "None of the above clearly fits."
                }
            };
        }

        questions[
            key +
            "_danger"
        ] = {
            type: "score",

            instructions:
                "If the user casually agrees with target " +
                key +
                ", what does it cost them? Jokes, stickers, small talk, and peer scheduling score at the bottom. Only deadlines, money, favors, and scope changes score high.",

            criteria: [
                "Harmless ordinary chat.",
                "Mild ambiguity, easy to clarify.",
                "Clear trap: extra work, compressed time, or vague scope.",
                "Severe: agreeing means rewriting a large piece of work, unpaid overtime, or being set up."
            ]
        };
    }

    questions.rewrite_half = {
        type: "noul",

        instructions:
            "Is the other person placing a new obligation on the user right now: extra work, a deadline, money, or a favor that was not already agreed? Jokes, stickers, small talk, and ordinary scheduling are false.",

        criteria: {
            "true":
                "Scope is expanding onto the user, or they are being asked to own an unrealistic delivery.",

            "false":
                "Ordinary chat, no material expansion of work."
        }
    };

    questions.global_danger = {
        type: "score",

        instructions:
            "If the user keeps saying yes, how much real pressure is in this conversation? Social chat with no ask stays at the bottom.",

        criteria: [
            "No real risk.",
            "Minor social or scheduling friction.",
            "Noticeable scope/time pressure.",
            "High: likely to eat days of work or create a commitment trap.",
            "Extreme: rewrite-the-project / overnight delivery / being set up to fail."
        ]
    };

    var body = {
        model:
            CONFIG.JEV.model,

        state: {
            relationship:
                CONFIG.relationship,

            app:
                capture.appName,

            source:
                capture.source,

            targets:
                targets
        },

        questions:
            questions
    };

    var json =
        postJson(
            CONFIG.JEV.endpoint,
            body,
            CONFIG.JEV.apiKey
        );

    if (!json ||
        !json.answers) {

        throw new Error(
            "TypeSafe 返回中没有 answers：\n" +
            truncate(
                JSON.stringify(
                    json
                ),
                900
            )
        );
    }

    var out = {};

    for (var k = 0;
         k < keys.length;
         k++) {

        var targetKey =
            keys[k];

        var tid =
            targetKey.replace(
                /^m/,
                ""
            );

        out[tid] = {
            reading:
                json.answers[
                    targetKey +
                    "_reading"
                ] ||
                null,

            intent:
                json.answers[
                    targetKey +
                    "_intent"
                ] ||
                null,

            danger:
                json.answers[
                    targetKey +
                    "_danger"
                ] ||
                null
        };
    }

    var rewriteAns =
        json.answers.rewrite_half;

    var dangerAns =
        json.answers.global_danger;

    out._global = {
        rewrite:
            rewriteAns &&
            typeof rewriteAns.noul ===
                "number"
                ? rewriteAns.noul
                : null,

        danger:
            dangerAns &&
            typeof dangerAns.score ===
                "number"
                ? clamp(
                    dangerAns.score /
                    4 *
                    10,
                    0,
                    10
                )
                : null,

        label:
            hypotheses._globalLabel ||
            "附加要求"
    };

    debugLog(
        "JEV",
        JSON.stringify(
            out,
            null,
            2
        )
    );

    return out;
}

function buildJevTargets(capture) {
    var targets = {};
    var messages =
        capture.messages;

    for (var i = 0;
         i < messages.length;
         i++) {

        var m =
            messages[i];

        if (!m.target) {
            continue;
        }

        var history = [];
        var start =
            Math.max(
                0,
                i - 10
            );

        for (var j = start;
             j <= i;
             j++) {

            history.push(
                semanticHistoryItem(
                    messages[j]
                )
            );
        }

        targets[
            "m" +
            m.id
        ] = {
            id:
                m.id,

            target_kind:
                m.kind,

            target_text:
                semanticTextForMessage(
                    m
                ),

            target_image_ref:
                m.kind === "media"
                    ? (
                        m.imageRef ||
                        null
                    )
                    : null,

            context_up_to_target:
                history
        };
    }

    return targets;
}


// ============================================================================
// 19. SUGGESTED ACTION — JEV VOICE
// ============================================================================

function generateActions(
    capture,
    hypotheses,
    analyses
) {
    var items = [];
    var messages =
        capture.messages;

    for (var i = 0;
         i < messages.length;
         i++) {

        var m =
            messages[i];

        if (!m.target) {
            continue;
        }

        var a =
            analyses[
                String(
                    m.id
                )
            ] || {};

        var hyp =
            hypotheses[
                String(
                    m.id
                )
            ] || {};

        var options =
            rankedJevOptions(
                hyp,
                a
            );

        items.push({
            id:
                m.id,

            target:
                semanticTextForMessage(
                    m
                ),

            hook:
                hyp.hook ||
                null,

            jev_distribution:
                options,

            danger:
                a.danger &&
                typeof a.danger.score ===
                    "number"
                    ? a.danger.score
                    : null
        });
    }

    if (items.length === 0) {
        return {};
    }

    var system =
        "你根据 Jev 已经打出的百分比写一条建议动作。" +
        "百分比以输入为准，禁止改数字，禁止另编概率。" +
        "只跟概率最高的那一项走：" +
        "闲聊、约局、表情包，就写一句能直接发出去的短回复，语气跟对方齐，10 到 22 个字。" +
        "对方在加需求、压时间、把事情推过来，才写一句边界，点明范围或优先级，不要答应。" +
        "普通聊天不要用项目经理的口吻。" +
        "禁止：哈哈、确实、有道理、嗯嗯、好好好、这种沟通方式、重写半个项目。" +
        "只输出 JSON：{\"items\":[{\"id\":1,\"action\":\"...\"}]}。";

    var body = {
        model:
            CONFIG.LLM.model,

        messages: [
            {
                role: "system",
                content: system
            },
            {
                role: "user",
                content:
                    buildMultimodalUserContent(
                        capture,
                        JSON.stringify({
                            relationship:
                                CONFIG.relationship,

                            app:
                                capture.appName,

                            global:
                                analyses._global ||
                                null,

                            items:
                                items
                        })
                    )
            }
        ],

        thinking: {
            type: "disabled"
        },

        response_format: {
            type: "json_object"
        },

        temperature: 0.45,
        max_tokens: 700,
        stream: false
    };

    var json =
        postJson(
            CONFIG.LLM.endpoint,
            body,
            CONFIG.LLM.apiKey
        );

    var content =
        extractAssistantContent(
            json,
            "Action"
        );

    var parsed =
        parseJsonStrict(
            content,
            "Action"
        );

    if (!parsed ||
        !Array.isArray(
            parsed.items
        )) {

        throw new Error(
            "建议动作返回缺少 items"
        );
    }

    var out = {};

    for (var k = 0;
         k < parsed.items.length;
         k++) {

        var item =
            parsed.items[k];

        if (!item ||
            item.id == null ||
            !item.action) {
            continue;
        }

        out[
            String(
                item.id
            )
        ] =
            String(
                item.action
            )
                .replace(
                    /\r?\n/g,
                    " "
                )
                .trim();
    }

    debugLog(
        "ACTIONS",
        JSON.stringify(
            out,
            null,
            2
        )
    );

    return out;
}

function buildMultimodalUserContent(
    capture,
    textPayload,
    includeImages
) {
    var parts = [
        {
            type: "text",
            text:
                textPayload
        }
    ];

    if (!includeImages) {
        return parts;
    }

    for (var i = 0;
         i < capture.messages.length;
         i++) {

        var m =
            capture.messages[i];

        if (m.kind !==
                "media" ||
            !m.imageDataUrl ||
            m.captureStatus !==
                "ok") {
            continue;
        }

        parts.push({
            type: "text",
            text:
                m.imageRef +
                " = message #" +
                m.id +
                " from " +
                m.from
        });

        parts.push({
            type: "image_url",
            image_url: {
                url:
                    m.imageDataUrl,
                detail:
                    CONFIG.multimodal
                        .detail
            }
        });
    }

    return parts;
}


// ============================================================================
// 20. SCORES
// ============================================================================

function choiceValue(x) {
    if (!x) {
        return null;
    }

    return x.choice ||
        null;
}

function valenceMinus5To5(x) {
    if (!x ||
        typeof x.score !==
            "number") {
        return 0;
    }

    // 9 档 0..8 -> -5..+5
    return clamp(
        (x.score - 4) /
        4 *
        5,
        -5,
        5
    );
}

function score0To10(x) {
    if (!x ||
        typeof x.score !==
            "number") {
        return 0;
    }

    // 7 档 0..6 -> 0..10
    return clamp(
        x.score /
        6 *
        10,
        0,
        10
    );
}

function intentZh(x) {
    var key =
        choiceValue(x);

    var map = {
        ask_information:
            "提问",
        ask_action:
            "请求行动",
        agree_or_confirm:
            "确认/赞同",
        praise_or_positive_reaction:
            "称赞/正面回应",
        joke_or_tease:
            "玩笑/调侃",
        share_information:
            "分享信息",
        express_opinion:
            "表达观点",
        complain_or_object:
            "抱怨/反对",
        reassure_or_support:
            "安慰/支持",
        close_topic:
            "收尾",
        other:
            "其他"
    };

    return map[key] ||
        key ||
        "意图不明";
}

function moodZh(x) {
    var key =
        choiceValue(x);

    var map = {
        positive:
            "正向",
        warm:
            "温暖",
        neutral:
            "中性",
        curious:
            "好奇",
        excited:
            "兴奋",
        anxious:
            "焦虑",
        disappointed:
            "失落",
        annoyed:
            "烦躁",
        angry:
            "生气",
        sarcastic:
            "讽刺",
        guarded:
            "防备",
        ambiguous:
            "不明确"
    };

    return map[key] ||
        key ||
        "心情不明";
}


// ============================================================================
// 21. COPY REPLY PICKER
// ============================================================================

function showReplyPicker() {
    if (!currentCapture ||
        !currentCapture.messages) {

        toast("还没有分析结果");
        return;
    }

    var ids = [];
    var labels = [];

    for (var i = 0;
         i < currentCapture
             .messages.length;
         i++) {

        var m =
            currentCapture
                .messages[i];

        if (!m.target) {
            continue;
        }

        var reply =
            currentReplies[
                String(
                    m.id
                )
            ];

        if (!reply) {
            continue;
        }

        ids.push(
            m.id
        );

        labels.push(
            "#" +
            m.id +
            " " +
            truncate(
                singleLine(
                    semanticTextForMessage(
                        m
                    )
                ),
                18
            ) +
            "\n→ " +
            truncate(
                reply,
                40
            )
        );
    }

    if (labels.length === 0) {
        toast("还没有可复制的建议");
        return;
    }

    var index =
        dialogs.select(
            "选择建议动作",
            labels
        );

    if (index >= 0 &&
        index < ids.length) {

        var chosen =
            currentReplies[
                String(
                    ids[index]
                )
            ];

        setClip(
            chosen
        );

        toast(
            "已复制 #" +
            ids[index]
        );
    }
}


// ============================================================================
// 22. HTTP / JSON
// ============================================================================

function postJson(
    url,
    body,
    key
) {
    var response =
        http.postJson(
            url,
            body,
            {
                headers: {
                    "Authorization":
                        "Bearer " +
                        key,

                    "Accept":
                        "application/json",

                    "User-Agent":
                        "Jev-Chat-Overlay-AutoJs6-v5"
                }
            }
        );

    var status =
        response.statusCode;

    var raw =
        response.body
            .string();

    var parsed = null;

    try {
        parsed =
            JSON.parse(
                raw
            );
    } catch (ignore) {}

    if (status < 200 ||
        status >= 300) {

        var detail =
            raw;

        try {
            if (parsed) {
                if (parsed.error &&
                    typeof parsed.error ===
                        "string") {

                    detail =
                        parsed.error;

                } else if (
                    parsed.error &&
                    parsed.error.message
                ) {

                    detail =
                        parsed.error
                            .message;

                } else if (
                    parsed.message
                ) {

                    detail =
                        parsed.message;

                } else {
                    detail =
                        JSON.stringify(
                            parsed
                        );
                }
            }
        } catch (ignore2) {}

        throw new Error(
            "HTTP " +
            status +
            "\n" +
            truncate(
                detail,
                1000
            )
        );
    }

    if (!parsed) {
        throw new Error(
            "API 返回的不是 JSON：\n" +
            truncate(
                raw,
                1000
            )
        );
    }

    return parsed;
}

function extractAssistantContent(
    json,
    provider
) {
    var content = null;

    try {
        content =
            json.choices[0]
                .message
                .content;
    } catch (e) {
        content = null;
    }

    if (Array.isArray(content)) {
        var parts = [];

        for (var i = 0;
             i < content.length;
             i++) {

            var part =
                content[i];

            if (typeof part ===
                "string") {
                parts.push(part);
            } else if (
                part &&
                part.text
            ) {
                parts.push(
                    String(
                        part.text
                    )
                );
            }
        }

        content =
            parts.join("\n");
    }

    if (!content) {
        try {
            content =
                json.choices[0]
                    .message
                    .reasoning_content;
        } catch (ignoreReason) {}
    }

    if (!content) {
        throw new Error(
            provider +
            " 返回格式异常：\n" +
            truncate(
                JSON.stringify(
                    json
                ),
                900
            )
        );
    }

    return String(content);
}

function parseJsonStrict(
    content,
    provider
) {
    var s =
        stripCodeFence(
            content
        );

    try {
        return JSON.parse(
            s
        );
    } catch (e) {
        throw new Error(
            provider +
            " JSON 无法解析：\n" +
            truncate(
                content,
                900
            )
        );
    }
}


// ============================================================================
// 23. FLOATY CAPTURE HIDE / RESTORE
// ============================================================================

function hideControlTemporarily() {
    var saved = {
        x:
            controlX,
        y:
            controlY
    };

    ui.run(function () {
        control.setPosition(
            -dp(500),
            -dp(500)
        );
    });

    return saved;
}

function restoreControl(saved) {
    ui.run(function () {
        control.setPosition(
            saved.x,
            saved.y
        );
    });
}

function hideWindowsForCapture() {
    var saved = {
        controlX:
            controlX,
        controlY:
            controlY,
        overlayVisible:
            overlayVisible
    };

    captureHidden = true;
    overlayVisible = false;

    ui.run(function () {
        try {
            overlay.canvas
                .invalidate();
        } catch (ignoreInv) {}

        try {
            overlay.setSize(
                1,
                1
            );
        } catch (ignoreSize) {}

        overlay.setPosition(
            SCREEN_W +
            dp(40),
            SCREEN_H +
            dp(40)
        );

        control.setPosition(
            -dp(500),
            -dp(500)
        );
    });

    sleep(420);

    return saved;
}

function restoreWindowsAfterCapture(
    saved
) {
    ui.run(function () {
        try {
            overlay.setSize(
                SCREEN_W,
                SCREEN_H
            );
        } catch (ignoreSize) {}

        control.setPosition(
            saved.controlX,
            saved.controlY
        );

        overlay.setPosition(
            0,
            0
        );
    });

    sleep(80);

    captureHidden = false;
    overlayVisible =
        saved.overlayVisible;

    refreshOverlayOrigin();

    raiseControl();

    invalidateOverlay();
}


// ============================================================================
// 24. DEBUG
// ============================================================================

function captureForDebug(capture) {
    return {
        appName:
            capture.appName,

        packageName:
            capture.packageName,

        source:
            capture.source,

        generic:
            capture.generic,

        mediaCount:
            capture.mediaCount,

        readableMediaCount:
            capture.readableMediaCount,

        protectedMediaCount:
            capture.protectedMediaCount,

        messages:
            capture.messages.map(
                function (m) {
                    return {
                        id:
                            m.id,

                        from:
                            m.from,

                        kind:
                            m.kind,

                        text:
                            m.text,

                        mediaHint:
                            m.mediaHint,

                        captureStatus:
                            m.captureStatus,

                        visualDescription:
                            m.visualDescription,

                        bounds: [
                            m.left,
                            m.top,
                            m.right,
                            m.bottom
                        ],

                        target:
                            m.target
                    };
                }
            )
    };
}

function debugLog(
    tag,
    value
) {
    if (!CONFIG.debug) {
        return;
    }

    try {
        console.log(
            "[" +
            tag +
            "] " +
            value
        );
    } catch (ignore) {}
}


// ============================================================================
// 25. UTIL
// ============================================================================

function singleLine(s) {
    return String(
        s == null
            ? ""
            : s
    )
        .replace(
            /\r?\n/g,
            " "
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}

function stripCodeFence(s) {
    s =
        String(
            s == null
                ? ""
                : s
        ).trim();

    s =
        s.replace(
            /^```(?:json)?\s*/i,
            ""
        );

    s =
        s.replace(
            /\s*```$/i,
            ""
        );

    return s.trim();
}

function truncate(
    s,
    n
) {
    s =
        String(
            s == null
                ? ""
                : s
        );

    return s.length <= n
        ? s
        : s.substring(
            0,
            n
        ) + "…";
}

function clamp(
    v,
    lo,
    hi
) {
    return Math.max(
        lo,
        Math.min(
            hi,
            v
        )
    );
}

function readableError(e) {
    if (e == null) {
        return "未知错误";
    }

    if (e.message) {
        return String(
            e.message
        );
    }

    return String(e);
}


// ============================================================================
// 26. EXIT
// ============================================================================

events.on("exit", function () {
    running = false;

    try {
        overlay.canvas
            .removeAllListeners();
    } catch (ignore0) {}

    try {
        overlay.close();
    } catch (ignore1) {}

    try {
        control.close();
    } catch (ignore2) {}
});

toast(
    "Jev Overlay v5.4：切聊天不会退出，点 J 重新分析"
);

var switchStreak = 0;
var pendingPkg = "";

setInterval(function () {
    try {
        if (!running || analyzing) {
            return;
        }

        var capture =
            currentCapture;

        if (!capture) {
            switchStreak = 0;
            pendingPkg = "";
            return;
        }

        var pkg = "";

        try {
            pkg =
                String(
                    currentPackage() ||
                    ""
                );
        } catch (ignorePkg) {
            return;
        }

        if (!pkg ||
            isIgnorablePackage(pkg) ||
            pkg === capture.packageName) {
            switchStreak = 0;
            pendingPkg = "";
            return;
        }

        if (pkg !== pendingPkg) {
            pendingPkg = pkg;
            switchStreak = 1;
            return;
        }

        switchStreak++;

        if (switchStreak < 3) {
            return;
        }

        switchStreak = 0;
        pendingPkg = "";

        var leftName =
            capture.appName ||
            "上一个应用";

        clearResults(false);

        toast(
            "已离开 " +
            leftName
        );
    } catch (watchErr) {
        debugLog(
            "WATCH",
            readableError(
                watchErr
            )
        );
    }
}, 800);
