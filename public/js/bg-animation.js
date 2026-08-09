(function () {
    var canvas = document.createElement('canvas');
    var layer = document.getElementById('bg-animation');
    if (!layer) return;

    layer.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var particles = [];
    var config = {
        count: 40,
        color: 'rgba(126, 34, 206, 0.15)',
        speed: 0.35,
        size: 2
    };

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = document.body.scrollHeight;
    }

    function seed() {
        particles = [];
        for (var i = 0; i < config.count; i++) {
            particles.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                vx: (Math.random() - 0.5) * config.speed,
                vy: (Math.random() - 0.5) * config.speed,
                r: Math.random() * config.size + 1
            });
        }
    }

    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (var i = 0; i < particles.length; i++) {
            var p = particles[i];
            p.x += p.vx;
            p.y += p.vy;
            if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
            if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = config.color;
            ctx.fill();
        }
        requestAnimationFrame(draw);
    }

    resize();
    seed();
    draw();
    window.addEventListener('resize', function () {
        resize();
        seed();
    });

    window.TorMartBg = {
        applyConfig: function (cfg) {
            if (!cfg || typeof cfg !== 'object') return;
            if (cfg.count) config.count = cfg.count;
            if (cfg.color) config.color = cfg.color;
            if (cfg.speed) config.speed = cfg.speed;
            if (cfg.size) config.size = cfg.size;
            seed();
        }
    };
})();
