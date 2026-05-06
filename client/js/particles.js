// js/particles.js - Efecto visual de partículas flotantes
function createParticles() {
    const container = document.getElementById('particles');
    if (!container) return;

    for (let i = 0; i < 60; i++) {
        const particle = document.createElement('div');
        particle.classList.add('particle');
        const size = Math.random() * 6 + 2;
        particle.style.width = size + 'px';
        particle.style.height = size + 'px';
        particle.style.left = Math.random() * 100 + '%';
        particle.style.animationDuration = Math.random() * 12 + 4 + 's';
        particle.style.animationDelay = Math.random() * 6 + 's';
        particle.style.background = `rgba(${100 + Math.random() * 155}, ${150 + Math.random() * 105}, 255, ${0.3 + Math.random() * 0.5})`;
        container.appendChild(particle);
    }
}

window.addEventListener('load', createParticles);
