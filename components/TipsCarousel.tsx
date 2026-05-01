import React, { useState, useEffect } from 'react';
import { Lightbulb } from 'lucide-react';
import { useUser } from '../contexts/UserContext';

interface TipsCarouselProps {
  interval?: number;
}

const TipsCarousel: React.FC<TipsCarouselProps> = ({ interval = 20000 }) => {
  const { t } = useUser();
  const tips = t.proTips;
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    if (tips.length === 0) return;

    const timer = setInterval(() => {
      setIsVisible(false); 
      setTimeout(() => {
        setCurrentIndex(prevIndex => (prevIndex + 1) % tips.length);
        setIsVisible(true);
      }, 300); 
    }, interval);

    return () => clearInterval(timer);
  }, [tips, interval]);

  if (tips.length === 0) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-[#d4af37]/10 dark:bg-[#d4af37]/20 text-sm text-[#333333] dark:text-[#b7b7b7]">
      <Lightbulb size={16} className="flex-shrink-0 text-[#d4af37] dark:text-[#f2d675]" />
      <p
        className="flex-grow transition-opacity duration-300 min-h-[1.25rem]"
        style={{ opacity: isVisible ? 1 : 0 }}
      >
        {tips[currentIndex]}
      </p>
    </div>
  );
};

export default TipsCarousel;